// Facts about a statement pulled from the Postgres parse tree: which tables
// it reads, the predicates on each, and the shapes that matter for
// performance (NOT IN, OFFSET, DISTINCT over joins, CTE materialisation,
// WHERE on the nullable side of an outer join). The plan analyser combines
// these with the executed plan.
import type { ParseResult } from '@pgsql/types'

export interface Relation {
  alias: string
  name: string
  schema: string | null
  /** Subquery or function in FROM rather than a table. */
  derived: boolean
  /** On the nullable side of an outer join. */
  nullable: boolean
}

export interface ColRef { alias: string | null; column: string }

export type PredicateOp = 'eq' | 'range' | 'like' | 'ilike' | 'regex' | 'ne' | 'null' | 'notnull' | 'in' | 'other'

export interface Predicate {
  /** Reconstructed SQL for the predicate, for display. */
  text: string
  /** Columns referenced on the indexed side. Empty when the side is not a column. */
  cols: ColRef[]
  op: PredicateOp
  /** The column sits inside a function call or cast. */
  wrapped: 'func' | 'cast' | null
  /** SQL for the wrapped expression, usable in CREATE INDEX. */
  exprSql: string | null
  /** For LIKE: pattern starts with % or _. */
  leadingWildcard: boolean
  /** For casts: the target type name. */
  castType: string | null
  /** Where the predicate appears. */
  clause: 'where' | 'on'
  /** Part of an OR, so it cannot be used as a plain index predicate. */
  inOr: boolean
  /** Compares two columns of different relations. */
  joinKey: boolean
  location: number
}

export interface Cte { name: string; materialized: 'always' | 'never' | 'default'; refs: number }

export interface SqlFacts {
  statement: string
  relations: Relation[]
  predicates: Predicate[]
  /** Groups of predicates under one OR. */
  orGroups: Predicate[][]
  /** Locations of `x NOT IN (subquery)`. */
  notInSubquery: number[]
  offset: number | null
  distinct: boolean
  selectStar: boolean
  ctes: Cte[]
  /** WHERE predicates on the nullable side of an outer join. */
  outerWhere: { alias: string; text: string }[]
  groupBy: boolean
  limit: boolean
}

type Columns = (schema: string | null, table: string) => string[] | undefined

/**
 * Extracts facts from the first statement. `columns` resolves unqualified
 * column names to relations when the query names more than one table.
 */
export function sqlFacts(ast: ParseResult, columns?: Columns): SqlFacts | null {
  const stmt = (ast.stmts?.[0] as any)?.stmt
  if (!stmt) return null
  const kind = Object.keys(stmt)[0]
  const body = stmt[kind]
  // Set operations wrap the real select; describe the left arm.
  const sel = kind === 'SelectStmt' && body.op && body.op !== 'SETOP_NONE' ? body.larg?.SelectStmt : body
  if (!sel) return null

  const facts: SqlFacts = {
    statement: kind.replace(/Stmt$/, '').toLowerCase(),
    relations: [], predicates: [], orGroups: [], notInSubquery: [], offset: null,
    distinct: Array.isArray(sel.distinctClause) && sel.distinctClause.length > 0,
    selectStar: false, ctes: [], outerWhere: [],
    groupBy: Array.isArray(sel.groupClause) && sel.groupClause.length > 0,
    limit: !!sel.limitCount,
  }

  // FROM: base relations and join quals. UPDATE/DELETE name their target directly.
  const from: any[] = [...(sel.fromClause ?? [])]
  if (body.relation?.RangeVar || body.relation) {
    const rv = body.relation.RangeVar ?? body.relation
    from.unshift({ RangeVar: rv })
  }
  const onQuals: { qual: any; nullable: string[] }[] = []
  const collect = (item: any, nullable: boolean) => {
    if (!item) return
    if (item.RangeVar) {
      const rv = item.RangeVar
      facts.relations.push({ alias: rv.alias?.aliasname ?? rv.relname, name: rv.relname, schema: rv.schemaname ?? null, derived: false, nullable })
    } else if (item.JoinExpr) {
      const j = item.JoinExpr
      const t = j.jointype
      collect(j.larg, nullable || t === 'JOIN_RIGHT' || t === 'JOIN_FULL')
      collect(j.rarg, nullable || t === 'JOIN_LEFT' || t === 'JOIN_FULL')
      if (j.quals) onQuals.push({ qual: j.quals, nullable: [] })
    } else if (item.RangeSubselect) {
      const alias = item.RangeSubselect.alias?.aliasname ?? 'subquery'
      facts.relations.push({ alias, name: alias, schema: null, derived: true, nullable })
    } else if (item.RangeFunction) {
      const alias = item.RangeFunction.alias?.aliasname ?? 'function'
      facts.relations.push({ alias, name: alias, schema: null, derived: true, nullable })
    }
  }
  for (const f of from) collect(f, false)

  // CTEs and how often each is referenced.
  for (const c of body.withClause?.ctes ?? sel.withClause?.ctes ?? []) {
    const cte = c.CommonTableExpr
    if (!cte) continue
    const m = cte.ctematerialized
    facts.ctes.push({
      name: cte.ctename,
      materialized: m === 'CTEMaterializeAlways' ? 'always' : m === 'CTEMaterializeNever' ? 'never' : 'default',
      refs: countRefs(stmt, cte.ctename),
    })
  }

  facts.selectStar = (sel.targetList ?? []).some((t: any) => {
    const f = t.ResTarget?.val?.ColumnRef?.fields
    return Array.isArray(f) && f.length === 1 && f[0].A_Star !== undefined
  })

  const off = sel.limitOffset?.A_Const?.ival?.ival
  if (typeof off === 'number') facts.offset = off

  const resolve = makeResolver(facts.relations, columns)
  const nullableAliases = new Set(facts.relations.filter(r => r.nullable).map(r => r.alias))

  const visit = (expr: any, clause: 'where' | 'on', inOr: boolean, into: Predicate[]) => {
    if (!expr) return
    if (expr.BoolExpr) {
      const b = expr.BoolExpr
      if (b.boolop === 'AND_EXPR') { for (const a of b.args ?? []) visit(a, clause, inOr, into); return }
      if (b.boolop === 'OR_EXPR') {
        const group: Predicate[] = []
        for (const a of b.args ?? []) visit(a, clause, true, group)
        if (group.length) facts.orGroups.push(group)
        into.push(...group)
        return
      }
      if (b.boolop === 'NOT_EXPR') {
        const inner = b.args?.[0]
        if (inner?.SubLink?.subLinkType === 'ANY_SUBLINK' && inner.SubLink.subselect) facts.notInSubquery.push(inner.SubLink.location ?? 0)
        return
      }
    }
    const p = predicate(expr, clause, inOr, resolve)
    if (p) into.push(p)
  }
  if (sel.whereClause) visit(sel.whereClause, 'where', false, facts.predicates)
  for (const q of onQuals) visit(q.qual, 'on', false, facts.predicates)

  for (const p of facts.predicates) {
    if (p.clause !== 'where' || p.joinKey || p.inOr || p.op === 'null' || !p.cols.length) continue
    if (p.cols.every(c => c.alias && nullableAliases.has(c.alias))) facts.outerWhere.push({ alias: p.cols[0].alias!, text: p.text })
  }
  return facts
}

function countRefs(node: any, name: string): number {
  let n = 0
  const walk = (v: any) => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (v.RangeVar?.relname === name && !v.RangeVar.schemaname) n++
    for (const k of Object.keys(v)) walk(v[k])
  }
  walk(node)
  return n
}

function makeResolver(relations: Relation[], columns?: Columns): (ref: ColRef) => ColRef {
  const bases = relations.filter(r => !r.derived)
  const cache = new Map<string, string[] | undefined>()
  const cols = (r: Relation) => {
    if (!columns) return undefined
    const k = `${r.schema ?? ''}.${r.name}`
    if (!cache.has(k)) cache.set(k, columns(r.schema, r.name) ?? (r.schema ? undefined : undefined))
    return cache.get(k)
  }
  return (ref) => {
    if (ref.alias) return ref
    if (bases.length === 1 && relations.length === 1) return { alias: bases[0].alias, column: ref.column }
    const owners = bases.filter(r => cols(r)?.includes(ref.column))
    if (owners.length === 1) return { alias: owners[0].alias, column: ref.column }
    return ref
  }
}

interface Side { cols: ColRef[]; wrapped: 'func' | 'cast' | null; sql: string; castType: string | null; isConst: boolean }

function side(expr: any, resolve: (r: ColRef) => ColRef): Side {
  const cols: ColRef[] = []
  let wrapped: Side['wrapped'] = null
  let castType: string | null = null
  const walk = (e: any, depth: number) => {
    if (!e || typeof e !== 'object') return
    if (e.ColumnRef) {
      const f = e.ColumnRef.fields ?? []
      const names = f.map((x: any) => x.String?.sval).filter((x: any) => typeof x === 'string')
      if (names.length && f[f.length - 1].A_Star === undefined) {
        cols.push(resolve({ alias: names.length > 1 ? names[names.length - 2] : null, column: names[names.length - 1] }))
      }
      return
    }
    if (e.FuncCall) { if (depth === 0) wrapped = 'func'; for (const a of e.FuncCall.args ?? []) walk(a, depth + 1); return }
    if (e.TypeCast) {
      if (depth === 0) { wrapped = 'cast'; castType = typeName(e.TypeCast.typeName) }
      walk(e.TypeCast.arg, depth + 1)
      return
    }
    if (e.A_Expr) { walk(e.A_Expr.lexpr, depth + 1); walk(e.A_Expr.rexpr, depth + 1); return }
    if (e.CoalesceExpr) { if (depth === 0) wrapped = 'func'; for (const a of e.CoalesceExpr.args ?? []) walk(a, depth + 1); return }
    if (e.A_Const || e.ParamRef || e.SubLink) return
    if (e.List) { for (const a of e.List.items ?? []) walk(a, depth + 1); return }
    for (const k of Object.keys(e)) walk(e[k], depth + 1)
  }
  walk(expr, 0)
  // A cast that only changes the string type is a no-op for indexing.
  if (wrapped === 'cast' && castType && ['text', 'varchar', 'character varying', 'bpchar', 'character'].includes(castType)) { wrapped = null; castType = null }
  if (cols.length === 0) { wrapped = null; castType = null }
  return { cols, wrapped, sql: deparse(expr), castType, isConst: cols.length === 0 }
}

function predicate(expr: any, clause: 'where' | 'on', inOr: boolean, resolve: (r: ColRef) => ColRef): Predicate | null {
  const loc = expr?.A_Expr?.location ?? expr?.NullTest?.location ?? expr?.SubLink?.location ?? 0
  if (expr.NullTest) {
    const s = side(expr.NullTest.arg, resolve)
    const isNull = expr.NullTest.nulltesttype === 'IS_NULL'
    return { text: `${s.sql} IS ${isNull ? '' : 'NOT '}NULL`, cols: s.cols, op: isNull ? 'null' : 'notnull', wrapped: s.wrapped, exprSql: s.wrapped ? s.sql : null, leadingWildcard: false, castType: s.castType, clause, inOr, joinKey: false, location: loc }
  }
  if (!expr.A_Expr) return null
  const a = expr.A_Expr
  const opName: string = a.name?.[0]?.String?.sval ?? ''
  const l = side(a.lexpr, resolve)
  const r = side(a.rexpr, resolve)
  let op: PredicateOp = 'other'
  switch (a.kind) {
    case 'AEXPR_OP':
      op = opName === '=' ? 'eq' : ['<', '>', '<=', '>='].includes(opName) ? 'range' : opName === '<>' || opName === '!=' ? 'ne' : opName === '~~' ? 'like' : opName === '~~*' ? 'ilike' : opName === '~' || opName === '~*' ? 'regex' : 'other'
      break
    case 'AEXPR_LIKE': op = opName === '!~~' ? 'other' : 'like'; break
    case 'AEXPR_ILIKE': op = opName === '!~~*' ? 'other' : 'ilike'; break
    case 'AEXPR_IN': op = opName === '<>' ? 'ne' : 'in'; break
    case 'AEXPR_BETWEEN': op = 'range'; break
    case 'AEXPR_OP_ANY': op = opName === '=' ? 'in' : 'other'; break
    default: op = 'other'
  }
  const text = `${l.sql} ${a.kind === 'AEXPR_IN' ? (opName === '<>' ? 'NOT IN' : 'IN') : a.kind === 'AEXPR_BETWEEN' ? 'BETWEEN' : a.kind === 'AEXPR_LIKE' ? (opName.startsWith('!') ? 'NOT LIKE' : 'LIKE') : a.kind === 'AEXPR_ILIKE' ? (opName.startsWith('!') ? 'NOT ILIKE' : 'ILIKE') : opName}${a.kind === 'AEXPR_OP_ANY' ? ' ANY' : ''} ${r.sql}`
  const lAliases = new Set(l.cols.map(c => c.alias))
  const rAliases = new Set(r.cols.map(c => c.alias))
  const joinKey = l.cols.length > 0 && r.cols.length > 0 && [...lAliases].some(x => !rAliases.has(x))
  // The indexed side is the one with columns compared to something constant.
  let s = l, mirrored = false
  if (l.isConst && !r.isConst) { s = r; mirrored = true }
  if (mirrored && op === 'range') op = 'range'
  let leadingWildcard = false
  if (op === 'like' || op === 'ilike') {
    const pat = a.rexpr?.A_Const?.sval?.sval
    leadingWildcard = typeof pat === 'string' ? /^[%_]/.test(pat) : true
  }
  return { text, cols: joinKey ? [...l.cols, ...r.cols] : s.cols, op, wrapped: joinKey ? null : s.wrapped, exprSql: s.wrapped ? s.sql : null, leadingWildcard, castType: s.castType, clause, inOr, joinKey, location: loc }
}

const typeAliases: Record<string, string> = { int4: 'integer', int8: 'bigint', int2: 'smallint', float8: 'double precision', float4: 'real', bool: 'boolean', varchar: 'varchar', bpchar: 'bpchar', timestamptz: 'timestamptz', timestamp: 'timestamp', numeric: 'numeric', text: 'text', date: 'date', interval: 'interval', time: 'time', timetz: 'timetz', uuid: 'uuid', jsonb: 'jsonb', json: 'json' }

function typeName(t: any): string {
  const names: string[] = (t?.names ?? []).map((n: any) => n.String?.sval).filter(Boolean)
  const last = names[names.length - 1] ?? 'unknown'
  const base = names[0] === 'pg_catalog' ? (typeAliases[last] ?? last) : names.join('.')
  return t?.arrayBounds?.length ? base + '[]' : base
}

/** Minimal SQL rendering of an expression, enough for hints and index definitions. */
export function deparse(e: any): string {
  if (!e || typeof e !== 'object') return '?'
  if (e.ColumnRef) return (e.ColumnRef.fields ?? []).map((f: any) => f.A_Star !== undefined ? '*' : quoteIdent(f.String?.sval ?? '?')).join('.')
  if (e.A_Const) {
    const c = e.A_Const
    if (c.isnull) return 'NULL'
    if (c.ival) return String(c.ival.ival ?? 0)
    if (c.fval) return String(c.fval.fval)
    if (c.sval) return `'${String(c.sval.sval).replace(/'/g, "''")}'`
    if (c.boolval) return c.boolval.boolval ? 'true' : 'false'
    if (c.bsval) return String(c.bsval.bsval)
    return '?'
  }
  if (e.ParamRef) return `$${e.ParamRef.number}`
  if (e.TypeCast) {
    const arg = e.TypeCast.arg
    const inner = deparse(arg)
    return arg?.A_Const ? `${inner}::${typeName(e.TypeCast.typeName)}` : `(${inner})::${typeName(e.TypeCast.typeName)}`
  }
  if (e.FuncCall) {
    const f = e.FuncCall
    const name = (f.funcname ?? []).map((n: any) => n.String?.sval).filter((n: string) => n && n !== 'pg_catalog').join('.')
    const args = f.agg_star ? '*' : (f.args ?? []).map(deparse).join(', ')
    return `${name}(${args})`
  }
  if (e.A_Expr) {
    const a = e.A_Expr
    const op = a.name?.[0]?.String?.sval ?? '?'
    if (a.kind === 'AEXPR_IN') return `${deparse(a.lexpr)} ${op === '<>' ? 'NOT IN' : 'IN'} (${(a.rexpr?.List?.items ?? []).map(deparse).join(', ')})`
    if (a.kind === 'AEXPR_BETWEEN') return `${deparse(a.lexpr)} BETWEEN ${(a.rexpr?.List?.items ?? []).map(deparse).join(' AND ')}`
    if (a.kind === 'AEXPR_LIKE') return `${deparse(a.lexpr)} ${op.startsWith('!') ? 'NOT LIKE' : 'LIKE'} ${deparse(a.rexpr)}`
    if (a.kind === 'AEXPR_ILIKE') return `${deparse(a.lexpr)} ${op.startsWith('!') ? 'NOT ILIKE' : 'ILIKE'} ${deparse(a.rexpr)}`
    if (a.kind === 'AEXPR_OP_ANY') return `${deparse(a.lexpr)} ${op} ANY (${deparse(a.rexpr)})`
    if (!a.lexpr) return `${op} ${deparse(a.rexpr)}`
    return `${deparse(a.lexpr)} ${op} ${deparse(a.rexpr)}`
  }
  if (e.BoolExpr) {
    const b = e.BoolExpr
    const args = (b.args ?? []).map(deparse)
    if (b.boolop === 'NOT_EXPR') return `NOT (${args[0] ?? ''})`
    return '(' + args.join(b.boolop === 'AND_EXPR' ? ' AND ' : ' OR ') + ')'
  }
  if (e.NullTest) return `${deparse(e.NullTest.arg)} IS ${e.NullTest.nulltesttype === 'IS_NULL' ? '' : 'NOT '}NULL`
  if (e.CoalesceExpr) return `coalesce(${(e.CoalesceExpr.args ?? []).map(deparse).join(', ')})`
  if (e.SubLink) return '(subquery)'
  if (e.List) return (e.List.items ?? []).map(deparse).join(', ')
  if (e.A_ArrayExpr) return `ARRAY[${(e.A_ArrayExpr.elements ?? []).map(deparse).join(', ')}]`
  if (e.CaseExpr) return 'CASE ... END'
  if (e.MinMaxExpr) return `${e.MinMaxExpr.op === 'IS_GREATEST' ? 'greatest' : 'least'}(${(e.MinMaxExpr.args ?? []).map(deparse).join(', ')})`
  if (e.SQLValueFunction) return String(e.SQLValueFunction.op ?? 'current_date').replace(/^SVFOP_/, '').toLowerCase()
  const k = Object.keys(e)[0]
  return k ? `<${k}>` : '?'
}

export function quoteIdent(s: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(s) && !reserved.has(s) ? s : `"${s.replace(/"/g, '""')}"`
}

const reserved = new Set(['all', 'and', 'any', 'as', 'asc', 'between', 'case', 'cast', 'check', 'column', 'constraint', 'create', 'default', 'desc', 'distinct', 'else', 'end', 'except', 'false', 'for', 'from', 'group', 'having', 'in', 'intersect', 'into', 'is', 'join', 'left', 'like', 'limit', 'not', 'null', 'offset', 'on', 'or', 'order', 'primary', 'right', 'select', 'table', 'then', 'to', 'true', 'union', 'unique', 'user', 'using', 'when', 'where', 'with'])
