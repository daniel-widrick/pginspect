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

  const onQuals = collectRelations(sel, body, facts)
  collectCtes(stmt, body, sel, facts)

  facts.selectStar = selectsStar(sel)
  facts.offset = constantOffset(sel)

  // Relations first: the resolver needs them to place unqualified columns.
  const resolve = makeResolver(facts.relations, columns)
  if (sel.whereClause) visitQual(sel.whereClause, 'where', false, facts.predicates, facts, resolve)
  for (const q of onQuals) visitQual(q, 'on', false, facts.predicates, facts, resolve)

  markOuterWhere(facts)
  return facts
}

function selectsStar(sel: any): boolean {
  return (sel.targetList ?? []).some((t: any) => {
    const f = t.ResTarget?.val?.ColumnRef?.fields
    return Array.isArray(f) && f.length === 1 && f[0].A_Star !== undefined
  })
}

/** OFFSET when it is a literal; a parameter or expression stays null. */
function constantOffset(sel: any): number | null {
  const off = sel.limitOffset?.A_Const?.ival?.ival
  return typeof off === 'number' ? off : null
}

/**
 * FROM: base relations, derived tables and the quals of every join, with each
 * relation marked when it sits on the nullable side of an outer join.
 * UPDATE and DELETE name their target outside the FROM list. Returns the join
 * quals for the predicate pass.
 */
function collectRelations(sel: any, body: any, facts: SqlFacts): any[] {
  const from: any[] = [...(sel.fromClause ?? [])]
  if (body.relation?.RangeVar || body.relation) {
    const rv = body.relation.RangeVar ?? body.relation
    from.unshift({ RangeVar: rv })
  }
  const onQuals: any[] = []
  const collect = (item: any, nullable: boolean) => {
    if (!item) return
    if (item.RangeVar) facts.relations.push(baseRelation(item.RangeVar, nullable))
    else if (item.JoinExpr) {
      const j = item.JoinExpr
      collect(j.larg, nullable || nullableSide(j.jointype, 'left'))
      collect(j.rarg, nullable || nullableSide(j.jointype, 'right'))
      if (j.quals) onQuals.push(j.quals)
    } else if (item.RangeSubselect) facts.relations.push(derivedRelation(item.RangeSubselect, 'subquery', nullable))
    else if (item.RangeFunction) facts.relations.push(derivedRelation(item.RangeFunction, 'function', nullable))
  }
  for (const f of from) collect(f, false)
  return onQuals
}

function baseRelation(rv: any, nullable: boolean): Relation {
  return { alias: rv.alias?.aliasname ?? rv.relname, name: rv.relname, schema: rv.schemaname ?? null, derived: false, nullable }
}

function derivedRelation(item: any, fallback: string, nullable: boolean): Relation {
  const alias = item.alias?.aliasname ?? fallback
  return { alias, name: alias, schema: null, derived: true, nullable }
}

/** A LEFT join makes its right side nullable, a RIGHT join its left, FULL both. */
function nullableSide(jointype: string, side: 'left' | 'right'): boolean {
  if (jointype === 'JOIN_FULL') return true
  return side === 'left' ? jointype === 'JOIN_RIGHT' : jointype === 'JOIN_LEFT'
}

/** CTEs, how each asked to be materialised, and how often the query names it. */
function collectCtes(stmt: any, body: any, sel: any, facts: SqlFacts): void {
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
}

/**
 * Walks a WHERE or ON tree. ANDs flatten into the current list; an OR keeps
 * its arms together as a group, since none of them can serve an index alone;
 * NOT only matters when it wraps an ANY sublink, which is NOT IN (subquery).
 */
function visitQual(expr: any, clause: 'where' | 'on', inOr: boolean, into: Predicate[], facts: SqlFacts, resolve: Resolver): void {
  if (!expr) return
  if (!expr.BoolExpr) {
    const p = predicate(expr, clause, inOr, resolve)
    if (p) into.push(p)
    return
  }
  const b = expr.BoolExpr
  const args: any[] = b.args ?? []
  switch (b.boolop) {
    case 'AND_EXPR':
      for (const a of args) visitQual(a, clause, inOr, into, facts, resolve)
      return
    case 'OR_EXPR': {
      const group: Predicate[] = []
      for (const a of args) visitQual(a, clause, true, group, facts, resolve)
      if (group.length) facts.orGroups.push(group)
      into.push(...group)
      return
    }
    case 'NOT_EXPR': {
      const loc = notInSubqueryLocation(args[0])
      if (loc !== null) facts.notInSubquery.push(loc)
      return
    }
  }
}

/** `x NOT IN (select ...)` parses as NOT over an ANY sublink; its location, or null for any other NOT. */
function notInSubqueryLocation(inner: any): number | null {
  const link = inner?.SubLink
  if (!link || link.subLinkType !== 'ANY_SUBLINK' || !link.subselect) return null
  return link.location ?? 0
}

/** WHERE predicates whose columns all belong to the nullable side of an outer join. */
function markOuterWhere(facts: SqlFacts): void {
  const nullableAliases = new Set(facts.relations.filter(r => r.nullable).map(r => r.alias))
  for (const p of facts.predicates) {
    if (p.clause !== 'where' || p.joinKey || p.inOr || p.op === 'null' || !p.cols.length) continue
    if (p.cols.every(c => c.alias && nullableAliases.has(c.alias))) facts.outerWhere.push({ alias: p.cols[0].alias!, text: p.text })
  }
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

type Resolver = (ref: ColRef) => ColRef

function makeResolver(relations: Relation[], columns?: Columns): Resolver {
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

/** What a walk over one side of a comparison collects. */
interface SideWalk { cols: ColRef[]; wrapped: Side['wrapped']; castType: string | null; resolve: Resolver }

// Children to descend into, per node kind. A kind with no entry is walked
// through generically; constants, parameters and sublinks are leaves.
const sideChildren: Record<string, (v: any) => any[]> = {
  FuncCall: v => v.args ?? [],
  CoalesceExpr: v => v.args ?? [],
  TypeCast: v => [v.arg],
  A_Expr: v => [v.lexpr, v.rexpr],
  List: v => v.items ?? [],
  A_Const: () => [],
  ParamRef: () => [],
  SubLink: () => [],
}

function walkSide(w: SideWalk, e: any, depth: number): void {
  if (!e || typeof e !== 'object') return
  const kind = Object.keys(e)[0]
  const v = kind ? e[kind] : undefined
  if (kind === 'ColumnRef') {
    const ref = columnRef(v)
    if (ref) w.cols.push(w.resolve(ref))
    return
  }
  // Only the outermost wrapper matters for indexing.
  if (depth === 0 && (kind === 'FuncCall' || kind === 'CoalesceExpr')) w.wrapped = 'func'
  if (depth === 0 && kind === 'TypeCast') { w.wrapped = 'cast'; w.castType = typeName(v.typeName) }
  const children = kind && sideChildren[kind] ? sideChildren[kind](v) : Object.values(e)
  for (const c of children) walkSide(w, c, depth + 1)
}

/** The column a ColumnRef names, with its qualifier, or null for a star. */
function columnRef(v: any): ColRef | null {
  const f = v.fields ?? []
  const names = f.map((x: any) => x.String?.sval).filter((x: any) => typeof x === 'string')
  if (!names.length || f[f.length - 1].A_Star !== undefined) return null
  return { alias: names.length > 1 ? names[names.length - 2] : null, column: names[names.length - 1] }
}

function side(expr: any, resolve: Resolver): Side {
  const w: SideWalk = { cols: [], wrapped: null, castType: null, resolve }
  walkSide(w, expr, 0)
  let { wrapped, castType } = w
  const cols = w.cols
  // A cast that only changes the string type is a no-op for indexing.
  if (wrapped === 'cast' && castType && ['text', 'varchar', 'character varying', 'bpchar', 'character'].includes(castType)) { wrapped = null; castType = null }
  if (cols.length === 0) { wrapped = null; castType = null }
  return { cols, wrapped, sql: deparse(expr), castType, isConst: cols.length === 0 }
}

function predicate(expr: any, clause: 'where' | 'on', inOr: boolean, resolve: Resolver): Predicate | null {
  const loc = exprLocation(expr)
  if (expr.NullTest) return nullTestPredicate(expr.NullTest, clause, inOr, resolve, loc)
  if (!expr.A_Expr) return null
  const a = expr.A_Expr
  const opName: string = a.name?.[0]?.String?.sval ?? ''
  const l = side(a.lexpr, resolve)
  const r = side(a.rexpr, resolve)
  const op = predicateOp(a.kind, opName)
  const text = `${l.sql} ${exprOperator(a.kind, opName)} ${r.sql}`
  const joinKey = comparesRelations(l, r)
  // The indexed side is the one with columns compared to something constant.
  const s = l.isConst && !r.isConst ? r : l
  return {
    text, cols: joinKey ? [...l.cols, ...r.cols] : s.cols, op, wrapped: joinKey ? null : s.wrapped,
    exprSql: s.wrapped ? s.sql : null, leadingWildcard: leadingWildcard(op, a.rexpr), castType: s.castType,
    clause, inOr, joinKey, location: loc,
  }
}

function exprLocation(expr: any): number {
  return expr?.A_Expr?.location ?? expr?.NullTest?.location ?? expr?.SubLink?.location ?? 0
}

/** Columns on both sides from different relations: a join key, not a filter. */
function comparesRelations(l: Side, r: Side): boolean {
  if (!l.cols.length || !r.cols.length) return false
  const rAliases = new Set(r.cols.map(c => c.alias))
  return l.cols.some(c => !rAliases.has(c.alias))
}

function nullTestPredicate(nt: any, clause: 'where' | 'on', inOr: boolean, resolve: Resolver, loc: number): Predicate {
  const s = side(nt.arg, resolve)
  const isNull = nt.nulltesttype === 'IS_NULL'
  return {
    text: `${s.sql} IS ${isNull ? '' : 'NOT '}NULL`, cols: s.cols, op: isNull ? 'null' : 'notnull', wrapped: s.wrapped,
    exprSql: s.wrapped ? s.sql : null, leadingWildcard: false, castType: s.castType, clause, inOr, joinKey: false, location: loc,
  }
}

/** How an A_Expr compares, reduced to what the index advice distinguishes. */
function predicateOp(kind: string, opName: string): PredicateOp {
  switch (kind) {
    case 'AEXPR_OP': return plainOperatorOp(opName)
    case 'AEXPR_LIKE': return opName === '!~~' ? 'other' : 'like'
    case 'AEXPR_ILIKE': return opName === '!~~*' ? 'other' : 'ilike'
    case 'AEXPR_IN': return opName === '<>' ? 'ne' : 'in'
    case 'AEXPR_BETWEEN': return 'range'
    case 'AEXPR_OP_ANY': return opName === '=' ? 'in' : 'other'
    default: return 'other'
  }
}

const plainOps: Record<string, PredicateOp> = {
  '=': 'eq', '<': 'range', '>': 'range', '<=': 'range', '>=': 'range', '<>': 'ne', '!=': 'ne',
  '~~': 'like', '~~*': 'ilike', '~': 'regex', '~*': 'regex',
}

function plainOperatorOp(opName: string): PredicateOp {
  return plainOps[opName] ?? 'other'
}

/** The SQL keyword an A_Expr reads as: NOT IN, BETWEEN, LIKE, = ANY, or the operator itself. */
function exprOperator(kind: string, op: string): string {
  switch (kind) {
    case 'AEXPR_IN': return op === '<>' ? 'NOT IN' : 'IN'
    case 'AEXPR_BETWEEN': return 'BETWEEN'
    case 'AEXPR_LIKE': return op.startsWith('!') ? 'NOT LIKE' : 'LIKE'
    case 'AEXPR_ILIKE': return op.startsWith('!') ? 'NOT ILIKE' : 'ILIKE'
    case 'AEXPR_OP_ANY': return `${op} ANY`
    default: return op
  }
}

/** For LIKE and ILIKE: a pattern starting with % or _ cannot use a btree. An unknown pattern is assumed to. */
function leadingWildcard(op: PredicateOp, rexpr: any): boolean {
  if (op !== 'like' && op !== 'ilike') return false
  const pat = rexpr?.A_Const?.sval?.sval
  return typeof pat === 'string' ? /^[%_]/.test(pat) : true
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
  const kind = Object.keys(e)[0]
  const render = kind ? deparsers[kind] : undefined
  if (render) return render(e[kind])
  return kind ? `<${kind}>` : '?'
}

const list = (items: any[] | undefined, sep = ', ') => (items ?? []).map(deparse).join(sep)

// One renderer per parse node kind. A node is an object with a single key
// naming its kind, so the table replaces a chain of type tests.
const deparsers: Record<string, (v: any) => string> = {
  ColumnRef: v => (v.fields ?? []).map((f: any) => f.A_Star !== undefined ? '*' : quoteIdent(f.String?.sval ?? '?')).join('.'),
  A_Const: deparseConst,
  ParamRef: v => `$${v.number}`,
  TypeCast: v => {
    const inner = deparse(v.arg)
    return v.arg?.A_Const ? `${inner}::${typeName(v.typeName)}` : `(${inner})::${typeName(v.typeName)}`
  },
  FuncCall: v => {
    const name = (v.funcname ?? []).map((n: any) => n.String?.sval).filter((n: string) => n && n !== 'pg_catalog').join('.')
    return `${name}(${v.agg_star ? '*' : list(v.args)})`
  },
  A_Expr: deparseAExpr,
  BoolExpr: v => {
    const args = (v.args ?? []).map(deparse)
    if (v.boolop === 'NOT_EXPR') return `NOT (${args[0] ?? ''})`
    return '(' + args.join(v.boolop === 'AND_EXPR' ? ' AND ' : ' OR ') + ')'
  },
  NullTest: v => `${deparse(v.arg)} IS ${v.nulltesttype === 'IS_NULL' ? '' : 'NOT '}NULL`,
  CoalesceExpr: v => `coalesce(${list(v.args)})`,
  SubLink: () => '(subquery)',
  List: v => list(v.items),
  A_ArrayExpr: v => `ARRAY[${list(v.elements)}]`,
  CaseExpr: () => 'CASE ... END',
  MinMaxExpr: v => `${v.op === 'IS_GREATEST' ? 'greatest' : 'least'}(${list(v.args)})`,
  SQLValueFunction: v => String(v.op ?? 'current_date').replace(/^SVFOP_/, '').toLowerCase(),
}

function deparseConst(c: any): string {
  if (c.isnull) return 'NULL'
  if (c.ival) return String(c.ival.ival ?? 0)
  if (c.fval) return String(c.fval.fval)
  if (c.sval) return `'${String(c.sval.sval).replace(/'/g, "''")}'`
  if (c.boolval) return c.boolval.boolval ? 'true' : 'false'
  if (c.bsval) return String(c.bsval.bsval)
  return '?'
}

function deparseAExpr(a: any): string {
  const op = a.name?.[0]?.String?.sval ?? '?'
  const left = deparse(a.lexpr)
  switch (a.kind) {
    case 'AEXPR_IN': return `${left} ${exprOperator(a.kind, op)} (${list(a.rexpr?.List?.items)})`
    case 'AEXPR_BETWEEN': return `${left} BETWEEN ${list(a.rexpr?.List?.items, ' AND ')}`
    case 'AEXPR_LIKE':
    case 'AEXPR_ILIKE': return `${left} ${exprOperator(a.kind, op)} ${deparse(a.rexpr)}`
    case 'AEXPR_OP_ANY': return `${left} ${op} ANY (${deparse(a.rexpr)})`
  }
  if (!a.lexpr) return `${op} ${deparse(a.rexpr)}`
  return `${left} ${op} ${deparse(a.rexpr)}`
}

export function quoteIdent(s: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(s) && !reserved.has(s) ? s : `"${s.replace(/"/g, '""')}"`
}

const reserved = new Set(['all', 'and', 'any', 'as', 'asc', 'between', 'case', 'cast', 'check', 'column', 'constraint', 'create', 'default', 'desc', 'distinct', 'else', 'end', 'except', 'false', 'for', 'from', 'group', 'having', 'in', 'intersect', 'into', 'is', 'join', 'left', 'like', 'limit', 'not', 'null', 'offset', 'on', 'or', 'order', 'primary', 'right', 'select', 'table', 'then', 'to', 'true', 'union', 'unique', 'user', 'using', 'when', 'where', 'with'])
