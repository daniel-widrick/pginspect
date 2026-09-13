// Optimisation hints derived from an EXPLAIN plan, optionally combined with
// facts from the statement's parse tree. Everything here is deterministic:
// each rule looks for a known shape (a filter applied after a join, a hash
// built from an unfiltered table, a sort spilling to disk) and names the fix.
import type { ParsedPlan, PlanNode } from './plan'
import { fmtNum as fmtExact, pct } from './plan'

const fmtNum = (n: number | null) => fmtExact(n === null ? null : Math.round(n))
import type { SqlFacts, Predicate, ColRef } from './sqlast'
import { quoteIdent } from './sqlast'

export type Severity = 'high' | 'medium' | 'low'
export type Category = 'index' | 'statistics' | 'memory' | 'rewrite' | 'rowflow' | 'config' | 'maintenance'

export interface Hint {
  id: string
  severity: Severity
  category: Category
  title: string
  /** Plain text; paragraphs separated by blank lines. */
  detail: string
  /** Plan node the hint is about, for highlighting. */
  nodeId: number | null
  /** SQL the user can copy to apply or test the suggestion. */
  fix?: string
  fixNote?: string
}

export interface FlowStep {
  node: PlanNode
  rowsIn: number
  rowsOut: number
  /** Fraction of input rows that survived. */
  kept: number
  /** A filter evaluated on a join or above it, after the rows were already joined. */
  late: boolean
}

export interface Analysis {
  hints: Hint[]
  /** Pipeline nodes in execution order, with row counts in and out. */
  flow: FlowStep[]
  /** Base relations in the query, from the parse tree when available. */
  relations: number
}

export interface AnalyzeOptions {
  facts?: SqlFacts | null
  serverMajor?: number
  /** Schema of a table the query text does not name (a table behind a view), when unambiguous. */
  schemaOf?: (table: string) => string | null | undefined
}

const scanTypes = new Set(['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan', 'Tid Scan', 'Tid Range Scan', 'Foreign Scan', 'Sample Scan'])
const joinTypes = new Set(['Nested Loop', 'Hash Join', 'Merge Join'])
const passThrough = new Set(['Materialize', 'Memoize', 'Gather', 'Gather Merge', 'Hash', 'Sort', 'Incremental Sort', 'Result', 'Subquery Scan'])
const collapseTypes = new Set(['Aggregate', 'Unique', 'Group', 'HashAggregate', 'GroupAggregate'])

interface Ctx {
  plan: ParsedPlan
  facts: SqlFacts | null
  serverMajor: number
  schemaOf: (table: string) => string | null | undefined
  tot: Map<number, number>
  removed: Map<number, number>
  rowsIn: Map<number, number>
  parent: Map<number, PlanNode>
  hints: Hint[]
}

export function analyzePlan(plan: ParsedPlan, opts: AnalyzeOptions = {}): Analysis {
  const ctx: Ctx = {
    plan, facts: opts.facts ?? null, serverMajor: opts.serverMajor ?? 0, schemaOf: opts.schemaOf ?? (() => null),
    tot: new Map(), removed: new Map(), rowsIn: new Map(), parent: new Map(), hints: [],
  }
  computeRows(ctx)
  const flow = rowFlow(ctx)

  for (const n of plan.nodes) {
    seqScanFilter(ctx, n)
    indexThenFilter(ctx, n)
    repeatedScan(ctx, n)
    misestimate(ctx, n)
    driveFromBigSide(ctx, n)
    lateFilter(ctx, n)
    cteFence(ctx, n)
    fanOut(ctx, n)
    subPlanPerRow(ctx, n)
    crossJoin(ctx, n)
    sortHints(ctx, n)
    hashBatches(ctx, n)
    lossyBitmap(ctx, n)
    heapFetches(ctx, n)
    workersShort(ctx, n)
  }
  joinCollapse(ctx)
  notIn(ctx)
  offsetPagination(ctx)
  outerWhere(ctx)
  selectStar(ctx)
  jitTime(ctx)
  triggerTime(ctx)
  planningTime(ctx)

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
  const hints = dedupe(ctx.hints).sort((a, b) => order[a.severity] - order[b.severity])
  const relations = ctx.facts ? ctx.facts.relations.filter(r => !r.derived).length : new Set(plan.nodes.filter(n => n.raw['Relation Name']).map(n => n.raw['Alias'] ?? n.raw['Relation Name'])).size
  return { hints, flow, relations }
}

// ---- row accounting ------------------------------------------------------

/** Total rows each node produced across all loops, and rows its filters discarded. */
function computeRows(ctx: Ctx) {
  const { plan } = ctx
  const analyze = plan.analyze
  const walk = (n: PlanNode, mult: number, workers: number) => {
    for (const c of n.children) ctx.parent.set(c.id, n)
    let rows: number
    if (analyze) rows = (n.actualRows ?? 0) * n.loops
    else rows = n.planRows * mult * workers
    ctx.tot.set(n.id, rows)
    const loops = analyze ? n.loops : mult * workers
    const removed = (num(n.raw['Rows Removed by Filter']) + num(n.raw['Rows Removed by Join Filter']) + num(n.raw['Rows Removed by Index Recheck'])) * (analyze ? n.loops : 1)
    ctx.removed.set(n.id, removed)
    // Parallel children report per-worker estimates; scale them back up.
    let childWorkers = workers
    if (!analyze && (n.type === 'Gather' || n.type === 'Gather Merge')) {
      const w = num(n.raw['Workers Planned'])
      const leader = 1 - 0.3 * w
      childWorkers = w + (leader > 0 ? leader : 0)
    }
    for (const c of n.children) {
      let childMult = mult
      if (!analyze && n.type === 'Nested Loop' && c.raw['Parent Relationship'] === 'Inner') childMult = Math.max(1, rows > 0 ? ctx.tot.get(n.children[0].id) ?? 1 : 1)
      if (!analyze && c.raw['Parent Relationship'] === 'SubPlan') childMult = Math.max(1, loops)
      walk(c, childMult, childWorkers)
    }
    if (analyze && n.type === 'Nested Loop' && ['Inner', 'Semi'].includes(String(n.raw['Join Type'] ?? 'Inner'))) {
      const inner = n.children.find(c => c.raw['Parent Relationship'] === 'Inner')
      if (inner && (ctx.tot.get(inner.id) ?? 0) < rows) ctx.tot.set(inner.id, rows)
    }
    const inputs = n.children.filter(c => isInput(c))
    let rowsIn: number
    if (inputs.length === 0) rowsIn = rows + removed
    else rowsIn = inputs.reduce((s, c) => s + (ctx.tot.get(c.id) ?? 0), 0)
    ctx.rowsIn.set(n.id, rowsIn)
  }
  walk(plan.root, 1, 1)
}

function isInput(c: PlanNode): boolean {
  const rel = c.raw['Parent Relationship']
  return rel !== 'InitPlan' && rel !== 'SubPlan'
}

function rowFlow(ctx: Ctx): FlowStep[] {
  const out: FlowStep[] = []
  const walk = (n: PlanNode) => {
    for (const c of n.children) if (isInput(c)) walk(c)
    const rowsIn = ctx.rowsIn.get(n.id) ?? 0
    const rowsOut = ctx.tot.get(n.id) ?? 0
    const late = (joinTypes.has(n.type) || (!scanTypes.has(n.type) && n.children.length > 0)) && (ctx.removed.get(n.id) ?? 0) > 0
    out.push({ node: n, rowsIn, rowsOut, kept: rowsIn > 0 ? rowsOut / rowsIn : 1, late })
  }
  walk(ctx.plan.root)
  return out
}

// ---- helpers -------------------------------------------------------------

function num(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function tot(ctx: Ctx, n: PlanNode): number { return ctx.tot.get(n.id) ?? 0 }
function removed(ctx: Ctx, n: PlanNode): number { return ctx.removed.get(n.id) ?? 0 }
function rowsIn(ctx: Ctx, n: PlanNode): number { return ctx.rowsIn.get(n.id) ?? 0 }

function share(ctx: Ctx, n: PlanNode): number {
  const p = ctx.plan
  if (p.analyze) return p.totalTime ? (n.exclTime ?? 0) / p.totalTime : 0
  return p.totalCost ? n.exclCost / p.totalCost : 0
}

function alias(n: PlanNode): string | null {
  return n.raw['Alias'] ?? n.raw['Relation Name'] ?? null
}

/** Schema-qualified table name for a scan node, using the query text when it names the schema. */
function tableName(ctx: Ctx, n: PlanNode): string {
  const rel = n.raw['Relation Name'] ?? '?'
  const a = alias(n)
  const fromSql = ctx.facts?.relations.find(r => r.alias === a && r.name === rel)
  const schema = n.raw['Schema'] ?? fromSql?.schema ?? ctx.schemaOf(rel)
  return (schema ? quoteIdent(schema) + '.' : '') + quoteIdent(rel)
}

function label(n: PlanNode): string {
  return n.type + (n.detail ? ' ' + n.detail : '')
}

/** Aliases referenced as alias.column in a plan expression. */
function aliasRefs(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of stripStrings(text).matchAll(/(?<![\w."])("[^"]+"|[A-Za-z_][\w$]*)\.(?:"[^"]+"|[A-Za-z_][\w$]*)/g)) out.add(m[1].replace(/^"|"$/g, ''))
  return out
}

function stripStrings(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, "''")
}

const exprKeywords = new Set(['and', 'or', 'not', 'is', 'null', 'true', 'false', 'any', 'all', 'some', 'in', 'like', 'ilike', 'between', 'similar', 'to', 'escape', 'case', 'when', 'then', 'else', 'end', 'subplan', 'initplan', 'hashed', 'distinct', 'from', 'array', 'row', 'interval', 'date', 'time', 'timestamp', 'zone', 'with', 'without', 'collate', 'at', 'current_date', 'current_timestamp', 'now', 'symmetric', 'asymmetric', 'unknown', 'nulls', 'first', 'last', 'asc', 'desc'])

interface TextPredicate { col: ColRef; op: string; wrapped: 'func' | 'cast' | null; exprSql: string | null; foreign: boolean; leadingWildcard: boolean }

/**
 * Column predicates from a plan expression such as
 * ((status = 'paid'::text) AND (total > '900'::numeric)). A fallback for
 * when the parse tree is unavailable or the planner rewrote the predicate.
 */
export function textPredicates(text: string, own: string | null): TextPredicate[] {
  const out: TextPredicate[] = []
  const s = stripStrings(text)
  const re = /(?<![\w."])(?:("[^"]+"|[A-Za-z_][\w$]*)\.)?("[^"]+"|[A-Za-z_][\w$]*)(?![\w$"(])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const qual = m[1]?.replace(/^"|"$/g, '') ?? null
    const name = m[2].replace(/^"|"$/g, '')
    const before = s.slice(0, m.index)
    if (/::\s*(?:[A-Za-z_][\w ]*)?$/.test(before)) continue
    if (/\.$/.test(before)) continue
    if (!qual && exprKeywords.has(name.toLowerCase())) continue
    if (/^\$\d+$/.test(name)) continue
    let after = s.slice(m.index + m[0].length)
    // Peel closing parens and casts to reach the operator.
    let wrapped: TextPredicate['wrapped'] = null
    let exprSql: string | null = null
    const castM = /^\)\s*::\s*([A-Za-z_][\w ]*?)(\[\])?(?=[\s)=<>~!]|$)/.exec(after)
    const funcM = /([A-Za-z_][\w.]*)\s*\(\s*\(?\s*$/.exec(before)
    if (castM && !['text', 'character varying', 'bpchar', 'character', 'varchar'].includes(castM[1].trim())) {
      wrapped = 'cast'
      exprSql = `(${qual ? qual + '.' : ''}${quoteIdent(name)})::${castM[1].trim()}${castM[2] ?? ''}`
    } else if (funcM && !['any', 'all', 'some', 'coalesce', 'not', 'and', 'or', 'array'].includes(funcM[1].toLowerCase())) {
      const fn = funcM[1]
      // Grab the function call text from the start of the name to its closing paren.
      const start = funcM.index
      let depth = 0, end = -1
      for (let i = start; i < s.length; i++) {
        if (s[i] === '(') depth++
        else if (s[i] === ')') { depth--; if (depth === 0) { end = i + 1; break } }
      }
      if (end > 0) { wrapped = 'func'; exprSql = s.slice(start, end).replace(/\(\((\w+)\)::text\)/g, '($1)').replace(/\((\w+)\)::text/g, '$1'); after = s.slice(end) }
      void fn
    }
    after = after.replace(/^[\s)]*(?:::[\w ]+(?:\[\])?)?[\s)]*/, '')
    let opM = /^(IS NOT NULL|IS NULL|= ANY|<> ALL|<>|!=|<=|>=|=|<|>|!~~\*|!~~|~~\*|~~|~\*|~|IS NOT DISTINCT FROM|IS DISTINCT FROM|@>|<@|&&|@@)/i.exec(after)
    // A column on the right of an operator, e.g. the p.id in (product_id = p.id).
    if (!opM) opM = /(<>|!=|<=|>=|=|<|>)\s*$/.exec(before.replace(/\(+$/, ''))
    if (!opM) continue
    let op = opM[1].toUpperCase()
    if (op === '= ANY') op = 'IN'
    const foreign = qual !== null && own !== null && qual !== own
    // The right-hand side may be a foreign column, e.g. (product_id = p.id).
    const rhs = /^\s*(?:=|<>|<=|>=|<|>)\s*("[^"]+"|[A-Za-z_][\w$]*)\.("[^"]+"|[A-Za-z_][\w$]*)/.exec(after)
    out.push({ col: { alias: qual, column: name }, op, wrapped, exprSql, foreign, leadingWildcard: false })
    if (rhs) {
      const rq = rhs[1].replace(/^"|"$/g, '')
      if (own && rq !== own) {
        // record the pairing by marking the last predicate's op as a join
        out[out.length - 1].op = 'JOIN'
      }
    }
  }
  // Leading wildcards need the original strings.
  for (const p of out) {
    if (p.op === '~~' || p.op === '~~*') {
      const idx = text.indexOf(p.col.column)
      const lit = /~~\*?\s*'([^']*)'/.exec(text.slice(idx))
      p.leadingWildcard = lit ? /^[%_]/.test(lit[1]) : true
    }
  }
  return out
}

interface IndexCol { sql: string; kind: 'eq' | 'range' | 'like' | 'null' | 'other'; expression: boolean; note?: string }

/** Turns predicates on one relation into an ordered index column list. */
function indexColumns(preds: { col: string; op: string; exprSql: string | null; wrapped: 'func' | 'cast' | null; leadingWildcard: boolean }[]): { cols: IndexCol[]; trgm: string[]; notes: string[] } {
  const cols: IndexCol[] = []
  const trgm: string[] = []
  const notes: string[] = []
  const seen = new Set<string>()
  for (const p of preds) {
    const op = p.op.toUpperCase()
    let kind: IndexCol['kind'] = 'other'
    if (op === '=' || op === 'EQ' || op === 'IN' || op === 'JOIN') kind = 'eq'
    else if (['<', '>', '<=', '>=', 'RANGE'].includes(op)) kind = 'range'
    else if (op === '~~' || op === 'LIKE') kind = 'like'
    else if (op === 'IS NULL' || op === 'NULL') kind = 'null'
    else if (op === '~~*' || op === 'ILIKE' || op === '~' || op === '~*' || op === 'REGEX') kind = 'like'
    else continue
    const sql = p.wrapped && p.exprSql ? `(${p.exprSql})` : quoteIdent(p.col)
    if (seen.has(sql)) continue
    seen.add(sql)
    if (kind === 'like') {
      if (p.leadingWildcard || op === '~~*' || op === 'ILIKE' || op === '~' || op === '~*' || op === 'REGEX') { trgm.push(sql); continue }
      cols.push({ sql: `${sql} text_pattern_ops`, kind, expression: !!p.wrapped, note: 'text_pattern_ops lets a btree serve LIKE with a fixed prefix' })
      continue
    }
    cols.push({ sql, kind, expression: !!p.wrapped })
  }
  const rank = { eq: 0, null: 1, range: 2, like: 3, other: 4 }
  cols.sort((a, b) => rank[a.kind] - rank[b.kind])
  if (cols.filter(c => c.kind === 'range').length > 1) notes.push('Only the first range column can bound the index scan; the others are filtered inside it.')
  return { cols, trgm, notes }
}

/** Predicates on a scan node's relation, from the parse tree when possible, else from the plan text. */
function scanPredicates(ctx: Ctx, n: PlanNode, keys: string[] = ['Filter']): { col: string; op: string; exprSql: string | null; wrapped: 'func' | 'cast' | null; leadingWildcard: boolean; source: 'sql' | 'plan' }[] {
  const own = alias(n)
  const out: ReturnType<typeof scanPredicates> = []
  const text = keys.map(k => n.raw[k]).filter(Boolean).map(String).join(' AND ')
  const fromText = textPredicates(text, own).filter(p => !p.foreign && p.op !== 'JOIN')
  const textCols = new Set(fromText.map(p => p.col.column))
  if (ctx.facts && own) {
    for (const p of ctx.facts.predicates) {
      if (p.inOr || p.joinKey || p.cols.length !== 1 || p.cols[0].alias !== own) continue
      // Only predicates the planner actually applied at this node.
      if (!textCols.has(p.cols[0].column) && text) continue
      out.push({ col: p.cols[0].column, op: p.op, exprSql: p.exprSql, wrapped: p.wrapped, leadingWildcard: p.leadingWildcard, source: 'sql' })
    }
  }
  if (out.length === 0) {
    const hasOr = / OR /i.test(stripStrings(text))
    if (!hasOr) for (const p of fromText) out.push({ col: p.col.column, op: p.op, exprSql: p.exprSql, wrapped: p.wrapped, leadingWildcard: p.leadingWildcard, source: 'plan' })
  }
  return out
}

function add(ctx: Ctx, h: Hint) { ctx.hints.push(h) }

function dedupe(hints: Hint[]): Hint[] {
  const seen = new Set<string>()
  return hints.filter(h => {
    const k = h.id + '|' + (h.fix ?? h.title)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function createIndex(table: string, cols: IndexCol[]): string {
  return `create index concurrently on ${table} (${cols.map(c => c.sql).join(', ')});`
}

/** Casting a timestamp to a date depends on the session time zone, so it cannot be indexed. */
function dateCastRewrite(p: { col: string; exprSql: string | null; wrapped: 'func' | 'cast' | null }): string | null {
  if (!p.exprSql) return null
  const e = p.exprSql.toLowerCase()
  if (p.wrapped === 'cast' && /::date$/.test(e)) return `${quoteIdent(p.col)} >= '<day>' and ${quoteIdent(p.col)} < '<day>'::date + 1`
  if (p.wrapped === 'func' && /^date_trunc\(/.test(e)) return `${quoteIdent(p.col)} >= '<start>' and ${quoteIdent(p.col)} < '<end>'`
  if (p.wrapped === 'func' && /^(date|extract|date_part)\(/.test(e)) return `${quoteIdent(p.col)} >= '<start>' and ${quoteIdent(p.col)} < '<end>'`
  return null
}

// ---- rules ---------------------------------------------------------------

function seqScanFilter(ctx: Ctx, n: PlanNode) {
  if (n.type !== 'Seq Scan' || !n.raw['Filter']) return
  const text = String(n.raw['Filter'])
  if (/SubPlan|InitPlan/.test(text)) return
  if ([...aliasRefs(text)].some(a => a !== alias(n))) return
  const scanned = rowsIn(ctx, n), kept = tot(ctx, n)
  const analyze = ctx.plan.analyze
  const significant = analyze ? scanned >= 10000 && kept <= scanned * 0.2 : share(ctx, n) >= 0.2
  if (!significant) return
  const preds = scanPredicates(ctx, n)
  const table = tableName(ctx, n)
  const where = analyze
    ? `The sequential scan on ${table} read ${fmtNum(scanned)} rows${n.loops > 1 ? ` over ${fmtNum(n.loops)} loops` : ''} and kept ${fmtNum(kept)} (${pct(kept / Math.max(1, scanned))}).`
    : `The sequential scan on ${table} carries ${pct(share(ctx, n))} of the estimated cost and its filter keeps an estimated ${fmtNum(kept)} rows.`
  const severity: Severity = analyze && scanned >= 100000 && kept <= scanned * 0.05 ? 'high' : 'medium'

  // Expressions that no index can serve because they are not immutable.
  for (const p of preds) {
    const rewrite = dateCastRewrite(p)
    if (rewrite) {
      add(ctx, { id: 'expr-rewrite', severity, category: 'rewrite', nodeId: n.id, title: `Filter on ${p.exprSql} cannot use an index`,
        detail: `${where}\n\nThe predicate wraps ${quoteIdent(p.col)} in ${p.exprSql}, which is not immutable for timestamps (it depends on the session time zone), so no index can be built on it. Compare the raw column against a range instead.`,
        fix: `where ${rewrite}`, fixNote: 'A plain btree index on the column then serves the range.' })
      return
    }
  }
  const { cols, trgm, notes } = indexColumns(preds)
  if (trgm.length) {
    add(ctx, { id: 'trgm', severity, category: 'index', nodeId: n.id, title: `Pattern match on ${table} scans the whole table`,
      detail: `${where}\n\nA LIKE or regular expression with a leading wildcard (or a case-insensitive match) cannot use a btree index. A trigram GIN index answers these directly.`,
      fix: `create extension if not exists pg_trgm;\ncreate index concurrently on ${table} using gin (${trgm.map(t => `${t} gin_trgm_ops`).join(', ')});`,
      fixNote: 'GIN indexes are larger and slower to update than btree; worth it for tables searched by substring.' })
  }
  if (cols.length) {
    const expr = cols.some(c => c.expression)
    add(ctx, { id: expr ? 'expr-index' : 'seq-scan-index', severity, category: 'index', nodeId: n.id,
      title: expr ? `Expression filter on ${table} has no index` : `Filter on ${table} has no usable index`,
      detail: `${where}\n\n${expr ? 'The predicate applies an expression to the column, so an index on the bare column cannot be used. An expression index over the same expression can.' : 'An index on the filtered column lets the planner fetch only the matching rows.'}${notes.length ? '\n\n' + notes.join('\n') : ''}`,
      fix: createIndex(table, cols), fixNote: cols.some(c => c.kind === 'null') ? 'For IS NULL on a mostly non-null column a partial index (... where col is null) is smaller.' : 'CONCURRENTLY avoids locking writes while the index builds. Check the column is selective enough: an index on a value that matches most rows will not be used.' })
  } else if (!trgm.length) {
    add(ctx, { id: 'seq-scan-filter', severity: 'medium', category: 'index', nodeId: n.id, title: `Filter on ${table} scans the whole table`,
      detail: `${where}\n\nThe filter is ${text}. No single-column index suggestion could be derived from it; consider whether an index (possibly partial or on an expression) could serve the dominant condition.` })
  }
}

function indexThenFilter(ctx: Ctx, n: PlanNode) {
  if (!['Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'].includes(n.type) || !n.raw['Filter']) return
  if (/SubPlan|InitPlan/.test(String(n.raw['Filter']))) return
  const rem = num(n.raw['Rows Removed by Filter']) * (ctx.plan.analyze ? n.loops : 1)
  const kept = tot(ctx, n)
  if (!ctx.plan.analyze || rem < 1000 || kept > rem) return
  // A lookup that fetches a couple of rows per loop has nothing to gain.
  if ((rem + kept) / n.loops < 10) return
  const table = tableName(ctx, n)
  const condNode = n.type === 'Bitmap Heap Scan' ? n.children.find(c => c.type === 'Bitmap Index Scan') ?? n : n
  const indexName = condNode.raw['Index Name'] ?? '?'
  const keyPreds = textPredicates(String(condNode.raw['Index Cond'] ?? ''), alias(n)).filter(p => !p.foreign)
  const filterPreds = scanPredicates(ctx, n)
  const keys = indexColumns(keyPreds.map(p => ({ col: p.col.column, op: p.op, exprSql: p.exprSql, wrapped: p.wrapped, leadingWildcard: p.leadingWildcard })))
  const extra = indexColumns(filterPreds)
  const filterCols = extra.cols.filter(c => !keys.cols.some(k => k.sql === c.sql))
  const detail = `Index ${indexName} found ${fmtNum(rem + kept)} rows${n.loops > 1 ? ` over ${fmtNum(n.loops)} loops` : ''}, then the filter ${n.raw['Filter']} threw away ${fmtNum(rem)} of them (${pct(rem / Math.max(1, rem + kept))}). Every discarded row was still fetched from the table.`
  if (filterCols.length && keys.cols.length) {
    const all = [...keys.cols.filter(c => c.kind === 'eq'), ...filterCols.filter(c => c.kind === 'eq'), ...keys.cols.filter(c => c.kind !== 'eq'), ...filterCols.filter(c => c.kind !== 'eq')]
    add(ctx, { id: 'extend-index', severity: rem >= 100000 ? 'high' : 'medium', category: 'index', nodeId: n.id, title: `Index ${indexName} needs the filter column too`,
      detail: `${detail}\n\nAdding the filtered column to the index lets the index scan skip those rows. Equality columns go first, then the range or sort column.`,
      fix: createIndex(table, all), fixNote: `If ${indexName} is only used for this pattern the new index replaces it; otherwise keep both. A partial index (... where ${filterPreds.map(p => quoteIdent(p.col)).join(', ')} ...) is an alternative when the filter value is fixed.` })
  } else {
    add(ctx, { id: 'index-filter', severity: 'medium', category: 'index', nodeId: n.id, title: `Index ${indexName} on ${table} then filters most rows away`, detail })
  }
}

/** A scan that runs once per outer row with a filter tied to that outer row. */
function repeatedScan(ctx: Ctx, n: PlanNode) {
  if (n.type !== 'Seq Scan' || n.loops < 10 || !ctx.plan.analyze) return
  const own = alias(n)
  const text = String(n.raw['Filter'] ?? '')
  const refs = [...aliasRefs(text)].filter(a => a !== own)
  if (!refs.length) return
  const scanned = rowsIn(ctx, n)
  if (scanned < 100000) return
  const table = tableName(ctx, n)
  const local = textPredicates(text, own).filter(p => !p.foreign && (p.op === 'JOIN' || p.op === '='))
  const cols = local.map(p => ({ sql: quoteIdent(p.col.column), kind: 'eq' as const, expression: false }))
  add(ctx, { id: 'repeated-scan', severity: 'high', category: 'index', nodeId: n.id, title: `${table} is scanned in full ${fmtNum(n.loops)} times`,
    detail: `This sequential scan runs once per row of ${refs.join(', ')}: ${fmtNum(n.loops)} loops reading ${fmtNum(scanned)} rows in total to keep ${fmtNum(tot(ctx, n))}. The filter ${text} ties each pass to the outer row, which is exactly what an index lookup does cheaply.`,
    fix: cols.length ? createIndex(table, cols) : undefined,
    fixNote: cols.length ? 'With the index each loop becomes an index scan on the join key.' : undefined })
}

function misestimate(ctx: Ctx, n: PlanNode) {
  if (n.actualRows === null) return
  const est = Math.max(n.planRows, 1), act = Math.max(n.actualRows, 1)
  const factor = act > est ? act / est : est / act
  const under = act > est
  if (factor < 5 || Math.max(n.actualRows, n.planRows) < 1000) return
  if (n.type === 'Hash' || n.type === 'Materialize' || n.type === 'Memoize' || n.type === 'Gather' || n.type === 'Gather Merge') return
  const f = factor >= 100 ? `${Math.round(factor)}x` : `${factor.toFixed(1)}x`
  const severity: Severity = factor >= 50 ? 'high' : 'medium'
  if (n.raw['Relation Name']) {
    const table = tableName(ctx, n)
    const conds = ['Index Cond', 'Recheck Cond', 'Filter'].map(k => n.raw[k]).filter(Boolean).map(String).join(' AND ')
    const preds = textPredicates(conds, alias(n)).filter(p => !p.foreign && p.op !== 'JOIN')
    const cols = [...new Set(preds.map(p => p.col.column))]
    const base = `The planner expected ${fmtNum(n.planRows)} rows from ${table} and got ${fmtNum(n.actualRows)}${n.loops > 1 ? ' per loop' : ''} (${under ? 'under' : 'over'}estimated ${f}). Bad estimates lead to the wrong join strategy and join order further up the plan.`
    if (cols.length >= 2) {
      const stat = `${(n.raw['Relation Name'] as string)}_${cols.join('_')}_stats`.replace(/[^\w]/g, '_')
      add(ctx, { id: 'ext-stats', severity, category: 'statistics', nodeId: n.id, title: `Row estimate off ${f} on ${table}: correlated columns`,
        detail: `${base}\n\nThe conditions combine ${cols.map(quoteIdent).join(' and ')}. Postgres assumes columns are independent unless extended statistics say otherwise, so correlated columns multiply into a far too small (or large) estimate.`,
        fix: `create statistics ${quoteIdent(stat)} (dependencies, ndistinct, mcv) on ${cols.map(quoteIdent).join(', ')} from ${table};\nanalyze ${table};`,
        fixNote: 'Extended statistics need Postgres 10+ (mcv needs 12+). If the estimate stays off, a higher statistics target for the columns helps: alter table ... alter column ... set statistics 1000.' })
    } else {
      add(ctx, { id: 'analyze', severity, category: 'statistics', nodeId: n.id, title: `Row estimate off ${f} on ${table}`,
        detail: `${base}\n\nStale or coarse statistics are the usual cause. Skewed values that are not in the most-common-values list, or expressions the planner has no statistics for, also produce this.`,
        fix: `analyze ${table};`, fixNote: cols.length === 1 ? `If ANALYZE does not fix it: alter table ${table} alter column ${quoteIdent(cols[0])} set statistics 1000; then analyze again. For an expression predicate, create statistics on the expression (Postgres 14+).` : 'If ANALYZE does not fix it, raise the statistics target for the filtered columns.' })
    }
    return
  }
  if (joinTypes.has(n.type)) {
    const inputsOk = n.children.filter(isInput).every(c => {
      const ce = Math.max(c.planRows, 1), ca = Math.max(c.actualRows ?? c.planRows, 1)
      return (ca > ce ? ca / ce : ce / ca) < 3
    })
    if (!inputsOk) return
    const nested = n.type === 'Nested Loop' && under
    const filtered = !!(n.raw['Filter'] || n.raw['Join Filter'])
    add(ctx, { id: 'join-estimate', severity: nested ? 'high' : filtered ? 'low' : 'medium', category: 'statistics', nodeId: n.id, title: `${n.type} produced ${f} ${under ? 'more' : 'fewer'} rows than planned`,
      detail: `Both inputs were estimated well, but the join itself was expected to produce ${fmtNum(n.planRows)} rows and produced ${fmtNum(n.actualRows)}${n.loops > 1 ? ' per loop' : ''}. ${filtered ? `The planner had to guess the selectivity of ${n.raw['Filter'] ?? n.raw['Join Filter']}; expressions and functions get a default guess rather than statistics.` : 'The planner misjudged how the join keys match up (skewed keys, or a join filter on correlated columns).'}${nested ? '\n\nBecause it expected few rows it chose a nested loop, which is the worst strategy when the row count is large.' : ''}`,
      fix: nested ? `set enable_nestloop = off;  -- for this session, to test\n-- then re-run explain analyze and compare` : undefined,
      fixNote: nested ? 'If the hash or merge join is much faster, fix the estimate (statistics, extended statistics on the join columns) rather than leaving the setting off.' : undefined })
  }
}

/** Finds the scan feeding a join input, looking through Hash, Materialize, Gather and Memoize. */
function scanUnder(n: PlanNode): PlanNode | null {
  let cur: PlanNode | null = n
  while (cur) {
    if (scanTypes.has(cur.type)) return cur
    if (!passThrough.has(cur.type) || cur.children.length !== 1) return null
    cur = cur.children[0]
  }
  return null
}

function hasCond(n: PlanNode): boolean {
  return ['Filter', 'Index Cond', 'Recheck Cond', 'TID Cond'].some(k => n.raw[k] !== undefined) || n.children.some(c => c.type === 'Bitmap Index Scan')
}

function aliasesUnder(n: PlanNode): Set<string> {
  const out = new Set<string>()
  const walk = (m: PlanNode) => { const a = alias(m); if (a && m.raw['Relation Name']) out.add(a); m.children.forEach(walk) }
  walk(n)
  return out
}

/** A join that reads an entire large table while the selective condition is on the other side. */
function driveFromBigSide(ctx: Ctx, n: PlanNode) {
  if (!joinTypes.has(n.type)) return
  const inputs = n.children.filter(isInput)
  if (inputs.length !== 2) return
  const out = tot(ctx, n)
  for (const side of inputs) {
    const scan = scanUnder(side)
    if (!scan || hasCond(scan)) continue
    const big = tot(ctx, scan)
    if (big < 10000 || out > big * 0.1) continue
    const other = inputs.find(i => i !== side)!
    const otherScan = scanUnder(other)
    const otherFiltered = otherScan ? hasCond(otherScan) : false
    if (!otherFiltered && tot(ctx, other) > big * 0.1) continue
    const table = tableName(ctx, scan)
    const own = alias(scan)
    // Which column of the big table does the join use?
    const conds = [n.raw['Hash Cond'], n.raw['Merge Cond'], ...descendantJoinConds(other)].filter(Boolean).map(String).join(' AND ')
    const cols = [...new Set(textPredicates(conds, null).filter(p => p.col.alias === own).map(p => p.col.column))]
    const severity: Severity = big >= 100000 ? 'high' : 'medium'
    add(ctx, { id: 'drive-from-big-side', severity, category: 'rowflow', nodeId: n.id, title: `All ${fmtNum(big)} rows of ${table} are read to keep ${fmtNum(out)}`,
      detail: `${n.type} reads ${table} in full (${fmtNum(big)} rows, no filter) and joins it against ${otherScan ? tableName(ctx, otherScan) : 'the other side'}, which carries the selective condition. Only ${pct(out / Math.max(1, big))} of the rows survive the join.\n\nThe restrictive condition is on the other side, so the cheaper plan starts there and looks up only the matching rows of ${table}. The planner will do that once ${table} has an index on the join key${cols.length ? ` (${cols.map(quoteIdent).join(', ')})` : ''}.`,
      fix: cols.length ? createIndex(table, cols.map(c => ({ sql: quoteIdent(c), kind: 'eq' as const, expression: false }))) : undefined,
      fixNote: cols.length ? 'Foreign key columns are not indexed automatically; this is the most common missing index.' : undefined })
  }
}

/** Index and join conditions below a node, which is where a parameterised join key shows up. */
function descendantJoinConds(n: PlanNode): string[] {
  const out: string[] = []
  const walk = (m: PlanNode) => {
    for (const k of ['Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond']) if (m.raw[k]) out.push(String(m.raw[k]))
    m.children.forEach(walk)
  }
  walk(n)
  return out
}

function descendantConds(n: PlanNode): string[] {
  const out: string[] = []
  const walk = (m: PlanNode) => {
    for (const k of ['Index Cond', 'Recheck Cond', 'Filter', 'Join Filter', 'Hash Cond', 'Merge Cond']) if (m.raw[k]) out.push(String(m.raw[k]))
    m.children.forEach(walk)
  }
  walk(n)
  return out
}

/** A predicate on one table evaluated at a join, after the rows were already joined. */
function lateFilter(ctx: Ctx, n: PlanNode) {
  if (!joinTypes.has(n.type)) return
  const inputs = n.children.filter(isInput)
  if (inputs.length !== 2) return
  for (const key of ['Filter', 'Join Filter'] as const) {
    const text = n.raw[key]
    if (!text) continue
    const rem = num(n.raw[key === 'Filter' ? 'Rows Removed by Filter' : 'Rows Removed by Join Filter']) * (ctx.plan.analyze ? n.loops : 1)
    const out = tot(ctx, n)
    if (ctx.plan.analyze && (rem < 1000 || rem < out)) continue
    if (!ctx.plan.analyze && key === 'Join Filter') continue
    const refs = aliasRefs(String(text))
    if (!refs.size) continue
    const sides = inputs.map(aliasesUnder)
    const inA = [...refs].every(a => sides[0].has(a)), inB = [...refs].every(a => sides[1].has(a))
    const hasOr = / OR /.test(stripStrings(String(text)))
    const joinType = String(n.raw['Join Type'] ?? 'Inner')
    const amount = ctx.plan.analyze ? `${fmtNum(rem + out)} joined rows were checked and ${fmtNum(rem)} (${pct(rem / Math.max(1, rem + out))}) discarded` : 'rows are joined first and filtered afterwards'
    if (inA || inB) {
      const side = inA ? inputs[0] : inputs[1]
      const rel = String(side.raw['Parent Relationship'])
      const nullable = (joinType === 'Left' && rel === 'Inner') || (joinType === 'Right' && rel === 'Outer') || joinType === 'Full'
      const tables = [...refs].join(', ')
      const written = ctx.facts?.relations.find(r => refs.has(r.alias) && r.nullable) ? 'the LEFT JOIN' : 'an outer join'
      let why: string, fix: string | undefined, fixNote: string | undefined
      if (nullable) {
        why = `${tables} is the nullable side of ${written}, so the condition cannot be pushed into its scan: applying it before the join would change which rows get NULL-extended.`
        fix = `-- if unmatched rows are not wanted, the join is really inner:\n-- ... inner join ${tables} on ... where ${text}\n-- if they are wanted, restrict ${tables} in a subquery and left join to that:\n-- ... left join (select ... from ${tables} where <condition>) ${tables} on ...`
        fixNote = 'Check the WHERE clause: a condition on the nullable side that is not IS NULL already turns the outer join into an inner one in effect.'
      } else if (hasOr) {
        why = 'The condition is an OR, so the planner cannot split it into per-table filters.'
      } else {
        why = 'The planner normally pushes single-table conditions down to the scan. It could not here, usually because the expression involves a non-immutable function, a subquery, or an outer join boundary.'
      }
      add(ctx, { id: 'late-filter', severity: rem >= 100000 ? 'high' : 'medium', category: 'rowflow', nodeId: n.id, title: `Condition on ${tables} is applied after the join`,
        detail: `${key} ${text} runs on the ${n.type} instead of on the scan of ${tables}: ${amount}.\n\n${why}`, fix, fixNote })
    } else if (hasOr) {
      add(ctx, { id: 'or-across-tables', severity: rem >= 100000 ? 'high' : 'medium', category: 'rewrite', nodeId: n.id, title: 'OR across two tables forces a full join',
        detail: `${key} ${text} mixes columns of ${[...refs].join(' and ')} in one OR, so neither side can be restricted before the join: ${amount}.\n\nSplit it into one query per branch and combine them, so each branch restricts its own table and can use its own index.`,
        fix: `-- select ... where <${[...refs][0]} condition>\n-- union all\n-- select ... where <${[...refs][1]} condition> and not (<${[...refs][0]} condition>)`,
        fixNote: 'UNION (without ALL) removes duplicates but costs a sort; the NOT clause on the second branch keeps UNION ALL correct.' })
    } else if (rem >= 100000) {
      add(ctx, { id: 'cross-table-filter', severity: 'low', category: 'rowflow', nodeId: n.id, title: 'Cross-table condition discards most joined rows',
        detail: `${key} ${text} compares columns of different tables, so it can only run after the join: ${amount}.\n\nIf one side can be restricted independently (a date window, a status), add that condition so fewer rows reach the join.` })
    }
  }
}

function cteFence(ctx: Ctx, n: PlanNode) {
  if (n.type !== 'CTE Scan' && n.type !== 'Subquery Scan') return
  const text = n.raw['Filter']
  if (!text) return
  const rem = removed(ctx, n), out = tot(ctx, n)
  if (ctx.plan.analyze ? rem < 1000 || rem < out : share(ctx, n) < 0.1) return
  const amount = ctx.plan.analyze ? `${fmtNum(rem + out)} rows were produced and ${fmtNum(rem)} (${pct(rem / Math.max(1, rem + out))}) then discarded by ${text}` : `the filter ${text} is applied to its output`
  if (n.type === 'CTE Scan') {
    const name = String(n.raw['CTE Name'] ?? '?')
    const cte = ctx.facts?.ctes.find(c => c.name === name)
    let why: string
    if (ctx.serverMajor && ctx.serverMajor < 12) why = `Before Postgres 12 every CTE is materialised, so ${name} is computed in full before the outer query filters it.`
    else if (cte?.materialized === 'always') why = `${name} is declared MATERIALIZED, so it is computed in full before the outer query filters it.`
    else if (cte && cte.refs > 1) why = `${name} is referenced ${cte.refs} times, so Postgres materialises it rather than inlining it, and the outer filter cannot reach inside.`
    else why = `${name} was materialised (it is recursive, has side effects, or is referenced more than once), so the outer filter cannot reach inside it.`
    add(ctx, { id: 'cte-fence', severity: rem >= 100000 ? 'high' : 'medium', category: 'rewrite', nodeId: n.id, title: `CTE ${name} is filtered after being fully computed`,
      detail: `${amount}.\n\n${why} Moving the condition into the CTE, or letting Postgres inline it, restricts the rows where they are read.`,
      fix: cte?.materialized === 'always' ? `with ${name} as not materialized (...)` : `with ${name} as (select ... where <the condition that is now outside>)`,
      fixNote: 'NOT MATERIALIZED needs Postgres 12+. A CTE referenced once is inlined by default from 12 on unless it is recursive or has side effects.' })
  } else {
    add(ctx, { id: 'subquery-fence', severity: rem >= 100000 ? 'high' : 'medium', category: 'rewrite', nodeId: n.id, title: 'Subquery is filtered after being fully computed',
      detail: `${amount}.\n\nThe subquery could not be flattened into the outer query (it has DISTINCT, GROUP BY, LIMIT, a window function, or a set operation), so its filter runs on the finished result. Put the condition inside the subquery.` })
  }
}

/** A join that multiplies rows which a later aggregate or DISTINCT collapses again. */
function fanOut(ctx: Ctx, n: PlanNode) {
  if (!joinTypes.has(n.type)) return
  const inputs = n.children.filter(isInput)
  if (inputs.length !== 2) return
  const out = tot(ctx, n)
  const small = Math.min(...inputs.map(i => tot(ctx, i)))
  if (out < 1000 || out < small * 2) return
  // Find the nearest ancestor that removes duplicates: DISTINCT or GROUP BY.
  let p = ctx.parent.get(n.id)
  while (p && !(p.type === 'Unique' || (collapseTypes.has(p.type) && p.raw['Group Key']))) {
    if (scanTypes.has(p.type)) return
    p = ctx.parent.get(p.id)
  }
  if (!p) return
  const after = tot(ctx, p)
  if (after > out / 2) return
  // One hint per collapse: the join right below it sees the whole multiplication.
  for (let q = ctx.parent.get(n.id); q && q !== p; q = ctx.parent.get(q.id)) if (joinTypes.has(q.type) && tot(ctx, q) >= out) return
  const groupKey = p.raw['Group Key']
  const isDistinct = !!ctx.facts?.distinct || p.type === 'Unique'
  const smallSide = inputs.find(i => tot(ctx, i) === small)!
  const smallScan = scanUnder(smallSide)
  const smallName = smallScan ? tableName(ctx, smallScan) : 'the smaller input'
  add(ctx, { id: 'fan-out', severity: out >= 100000 ? 'high' : 'medium', category: 'rowflow', nodeId: n.id, title: `Join multiplies rows ${(out / Math.max(1, small)).toFixed(1)}x, then ${isDistinct ? 'DISTINCT' : p.type} collapses them`,
    detail: `${n.type} turns ${fmtNum(small)} rows of ${smallName} into ${fmtNum(out)} joined rows; the ${p.type}${groupKey ? ` on ${Array.isArray(groupKey) ? groupKey.join(', ') : groupKey}` : ''} above reduces them to ${fmtNum(after)}. Every multiplied row was built, carried and then thrown away.\n\n${isDistinct ? 'When DISTINCT exists only to undo join duplication, the join is really an existence test.' : 'Aggregate the many-side before joining, or join only what the aggregate needs.'}`,
    fix: isDistinct ? `-- replace the join with an existence test:\nselect ... from ${smallName} x\nwhere exists (select 1 from <joined tables> where <join condition to x> and <their conditions>)` : `-- aggregate the many side first:\nselect ... from ${smallName} x\njoin (select <key>, count(*), ... from <many side> group by <key>) m on m.<key> = x.<key>`,
    fixNote: 'Compare with EXPLAIN ANALYZE: the semi-join stops at the first match per row instead of producing every combination.' })
}

function subPlanPerRow(ctx: Ctx, n: PlanNode) {
  const role = n.role
  if (!/^SubPlan/.test(role)) return
  if (!ctx.plan.analyze) {
    const parent = ctx.parent.get(n.id)
    const per = parent ? tot(ctx, parent) : 0
    // The subplan's cost is per execution; the scan above pays it once per row.
    const costShare = ctx.plan.totalCost ? Math.min(1, (per * n.totalCost) / ctx.plan.totalCost) : 0
    if (per < 1000 || costShare < 0.05) return
    add(ctx, { id: 'subplan-per-row', severity: costShare >= 0.3 ? 'high' : 'medium', category: 'rewrite', nodeId: n.id, title: `Correlated subquery runs once per row (about ${fmtNum(Math.round(per))} times)`,
      detail: `${role} depends on the outer row, so it is re-executed for every row of ${label(parent!)}; the estimate is ${fmtNum(Math.round(per))} executions. Each execution starts the subquery from scratch.\n\nA join, a LATERAL subquery, or a window function computes the same result in one pass. Where the subquery only tests existence, EXISTS lets the planner turn it into a semi-join.`,
      fix: `-- instead of (select agg(...) from t where t.key = outer.key) per row:\n-- join (select key, agg(...) from t group by key) s on s.key = outer.key`,
      fixNote: 'If the subquery must stay correlated, an index on its correlation column keeps each execution cheap.' })
    return
  }
  if (n.loops < 100) return
  const t = n.inclTime ?? 0
  const f = ctx.plan.totalTime ? t / ctx.plan.totalTime : 0
  if (f < 0.05) return
  add(ctx, { id: 'subplan-per-row', severity: f >= 0.3 ? 'high' : 'medium', category: 'rewrite', nodeId: n.id, title: `Correlated subquery runs ${fmtNum(n.loops)} times`,
    detail: `${role} is executed once per outer row (${fmtNum(n.loops)} executions, ${pct(f)} of the run time). Each execution starts the subquery from scratch.\n\nA join, a LATERAL subquery, or a window function computes the same result in one pass. Where the subquery only tests existence, EXISTS lets the planner turn it into a semi-join.`,
    fix: `-- instead of (select agg(...) from t where t.key = outer.key) per row:\n-- join (select key, agg(...) from t group by key) s on s.key = outer.key`,
    fixNote: 'If the subquery must stay correlated, an index on its correlation column keeps each execution cheap.' })
}

function crossJoin(ctx: Ctx, n: PlanNode) {
  if (n.type !== 'Nested Loop' || n.raw['Join Filter']) return
  const inputs = n.children.filter(isInput)
  if (inputs.length !== 2) return
  const [outer, inner] = inputs
  const outerAliases = aliasesUnder(outer)
  // A parameterised inner side references the outer row somewhere in its conditions.
  const conds = descendantConds(inner).join(' AND ')
  for (const a of aliasRefs(conds)) if (outerAliases.has(a)) return
  const o = tot(ctx, outer)
  const perLoop = ctx.plan.analyze ? (inner.actualRows ?? 0) : inner.planRows
  const out = tot(ctx, n)
  if (o <= 1 || perLoop <= 1 || out < o * perLoop * 0.98) return
  const names = [outer, inner].map(s => { const sc = scanUnder(s); return sc ? tableName(ctx, sc) : s.type })
  add(ctx, { id: 'cross-join', severity: out >= 10000 ? 'high' : 'low', category: 'rewrite', nodeId: n.id, title: `Cross join between ${names[0]} and ${names[1]}`,
    detail: `No condition links the two inputs, so every row of one is paired with every row of the other: ${fmtNum(o)} x ${fmtNum(perLoop)} = ${fmtNum(out)} rows.\n\n${out >= 10000 ? 'Unless a cartesian product is intended, a join condition is missing (often a table listed in FROM that the WHERE clause never ties to the others).' : 'Small enough to be harmless if intended.'}` })
}

function sortHints(ctx: Ctx, n: PlanNode) {
  if (n.type !== 'Sort' && n.type !== 'Incremental Sort') return
  const disk = n.raw['Sort Space Type'] === 'Disk'
  const used = num(n.raw['Sort Space Used'])
  const input = rowsIn(ctx, n)
  const parent = ctx.parent.get(n.id)
  const limited = parent?.type === 'Limit' || (parent?.type === 'Gather Merge' && ctx.parent.get(parent.id)?.type === 'Limit')
  const child = n.children[0]
  const scan = child && scanTypes.has(child.type) ? child : null
  const keys: string[] = Array.isArray(n.raw['Sort Key']) ? n.raw['Sort Key'].map(String) : []
  const own = scan ? alias(scan) : null
  // Sort keys that are plain columns of the scanned table can come from an index.
  const keyCols = keys.map(k => {
    const m = /^(?:("[^"]+"|[A-Za-z_][\w$]*)\.)?("[^"]+"|[A-Za-z_][\w$]*)(?:\s+(DESC|ASC))?(?:\s+NULLS\s+(FIRST|LAST))?$/i.exec(k.trim())
    if (!m) return null
    if (m[1] && own && m[1].replace(/"/g, '') !== own) return null
    return { sql: quoteIdent(m[2].replace(/"/g, '')) + (m[3] ? ' ' + m[3].toLowerCase() : '') + (m[4] ? ' nulls ' + m[4].toLowerCase() : ''), kind: 'other' as const, expression: false }
  })
  const indexable = scan && keyCols.every(Boolean) && keyCols.length > 0
  if (disk) {
    const mb = Math.max(1, Math.ceil((used * 1.5) / 1024))
    add(ctx, { id: 'sort-disk', severity: used >= 100000 ? 'high' : 'medium', category: 'memory', nodeId: n.id, title: `Sort of ${fmtNum(input)} rows spills to disk`,
      detail: `The sort used ${fmtNum(used)} kB of temporary files (${n.raw['Sort Method']}) because work_mem was too small to hold the rows. Disk sorts are several times slower than in-memory ones.${indexable ? `\n\nAn index in sort order removes the sort entirely: the scan of ${tableName(ctx, scan!)} returns rows already ordered.` : ''}`,
      fix: `set work_mem = '${mb}MB';  -- for this session, or per role: alter role ... set work_mem = '${mb}MB'`,
      fixNote: `work_mem is per sort or hash operation, per backend; a query with several sorts can use multiples of it, so raise it for the role or session rather than globally.${indexable ? `\n\nAlternative: ${createIndex(tableName(ctx, scan!), [...(scan!.raw['Index Cond'] ? indexColumns(textPredicates(String(scan!.raw['Index Cond']), own).filter(p => !p.foreign).map(p => ({ col: p.col.column, op: p.op, exprSql: p.exprSql, wrapped: p.wrapped, leadingWildcard: p.leadingWildcard }))).cols.filter(c => c.kind === 'eq') : []), ...(keyCols as IndexCol[])])}` : ''}` })
    return
  }
  if (limited && indexable && input >= 100000) {
    const table = tableName(ctx, scan!)
    const eq = scanPredicates(ctx, scan!, ['Filter', 'Index Cond', 'Recheck Cond']).filter(p => p.op === 'eq' || p.op === '=')
    const eqCols = indexColumns(eq).cols
    add(ctx, { id: 'top-n-index', severity: input >= 1000000 ? 'high' : 'medium', category: 'index', nodeId: n.id, title: `Sorting ${fmtNum(input)} rows to return the first ${fmtNum(tot(ctx, parent!))}`,
      detail: `LIMIT with ORDER BY still sorts every candidate row (${n.raw['Sort Method'] ?? 'sort'} over ${fmtNum(input)} rows) before taking the first few. With an index in the sort order the scan of ${table} reads rows in order and stops after the limit.`,
      fix: createIndex(table, [...eqCols, ...(keyCols as IndexCol[])]),
      fixNote: eqCols.length ? 'Equality filter columns go first so the index range starts at the right place, then the sort columns.' : 'DESC and NULLS placement in the index must match the ORDER BY, or the planner reads it backwards only when that matches too.' })
  }
}

function hashBatches(ctx: Ctx, n: PlanNode) {
  if (n.type === 'Hash' && num(n.raw['Hash Batches']) > 1) {
    const batches = num(n.raw['Hash Batches'])
    const peak = num(n.raw['Peak Memory Usage'])
    const mb = Math.max(1, Math.ceil((peak * batches * 1.5) / 1024))
    add(ctx, { id: 'hash-batches', severity: batches >= 16 ? 'high' : 'medium', category: 'memory', nodeId: n.id, title: `Hash join spills: ${batches} batches`,
      detail: `The hash table for ${fmtNum(tot(ctx, n))} rows did not fit in work_mem, so the join was split into ${batches} batches written to and read back from temporary files. Peak memory per batch was ${fmtNum(peak)} kB, so about ${fmtNum(peak * batches)} kB would hold the whole table.`,
      fix: `set work_mem = '${mb}MB';  -- for this session, or per role`,
      fixNote: 'Alternatively hash the smaller table: a filter that shrinks this input, or better statistics so the planner picks the smaller side to hash.' })
  }
  if ((n.type === 'Aggregate' || n.type === 'HashAggregate') && num(n.raw['Disk Usage']) > 0) {
    const disk = num(n.raw['Disk Usage'])
    const mb = Math.max(1, Math.ceil((disk * 2) / 1024))
    add(ctx, { id: 'hashagg-disk', severity: disk >= 100000 ? 'high' : 'medium', category: 'memory', nodeId: n.id, title: `Hash aggregate spills ${fmtNum(disk)} kB to disk`,
      detail: `The hash table for the aggregate did not fit in work_mem (${n.raw['HashAgg Batches'] ?? '?'} batches). Grouping ${fmtNum(rowsIn(ctx, n))} rows into ${fmtNum(tot(ctx, n))} groups needs memory for every group.`,
      fix: `set work_mem = '${mb}MB';  -- for this session, or per role` })
  }
}

function lossyBitmap(ctx: Ctx, n: PlanNode) {
  const lossy = num(n.raw['Lossy Heap Blocks'])
  if (n.type !== 'Bitmap Heap Scan' || lossy === 0) return
  const exact = num(n.raw['Exact Heap Blocks'])
  add(ctx, { id: 'lossy-bitmap', severity: lossy > exact ? 'medium' : 'low', category: 'memory', nodeId: n.id, title: `Bitmap scan went lossy on ${fmtNum(lossy)} blocks`,
    detail: `The bitmap exceeded work_mem, so ${fmtNum(lossy)} heap blocks (against ${fmtNum(exact)} exact) were recorded at page granularity and every row in them had to be rechecked against ${n.raw['Recheck Cond']}.`,
    fix: `set work_mem = '64MB';  -- for this session; the bitmap needs a few bytes per matching row` })
}

function heapFetches(ctx: Ctx, n: PlanNode) {
  if (n.type !== 'Index Only Scan') return
  const fetches = num(n.raw['Heap Fetches'])
  const rows = tot(ctx, n)
  if (fetches < 1000 || fetches < rows * 0.5) return
  const table = tableName(ctx, n)
  add(ctx, { id: 'heap-fetches', severity: fetches >= rows ? 'medium' : 'low', category: 'maintenance', nodeId: n.id, title: `Index-only scan on ${table} still visits the table`,
    detail: `${fmtNum(fetches)} of ${fmtNum(rows)} rows needed a heap fetch to check visibility, because the visibility map does not mark their pages all-visible. That happens after inserts, updates or deletes until VACUUM runs.`,
    fix: `vacuum (analyze) ${table};`, fixNote: 'If it recurs, autovacuum is not keeping up with the write rate on this table: lower autovacuum_vacuum_scale_factor for it.' })
}

function workersShort(ctx: Ctx, n: PlanNode) {
  if (n.raw['Workers Launched'] === undefined) return
  const launched = num(n.raw['Workers Launched']), planned = num(n.raw['Workers Planned'])
  if (launched >= planned) return
  add(ctx, { id: 'workers-short', severity: launched === 0 ? 'medium' : 'low', category: 'config', nodeId: n.id, title: `Only ${launched} of ${planned} parallel workers started`,
    detail: `The plan was costed for ${planned} workers but the server had ${launched} available when it ran, so the leader did more of the work than planned. Other parallel queries were using the pool, or max_parallel_workers / max_worker_processes is low.`,
    fix: `show max_parallel_workers;\nshow max_worker_processes;\nshow max_parallel_workers_per_gather;` })
}

function joinCollapse(ctx: Ctx) {
  const n = ctx.facts ? ctx.facts.relations.filter(r => !r.derived).length : new Set(ctx.plan.nodes.filter(m => m.raw['Relation Name'] && m.raw['Parent Relationship'] !== 'SubPlan' && m.raw['Parent Relationship'] !== 'InitPlan').map(m => alias(m))).size
  if (n <= 8) return
  const geqo = n >= 12
  add(ctx, { id: 'join-collapse', severity: geqo ? 'high' : 'medium', category: 'config', nodeId: null, title: `${n} tables: join order is ${geqo ? 'searched heuristically' : 'partly fixed by how the query is written'}`,
    detail: `The query joins ${n} relations. Above join_collapse_limit (default 8) the planner stops considering every join order and keeps the order the FROM clause is written in across that boundary${geqo ? ', and at geqo_threshold (default 12) it switches to a genetic search that samples orders rather than comparing them all' : ''}.\n\nThis is where the written order matters: put the most restrictive table and its joins first so the early joins produce the fewest rows. Or raise the limits for this session so the planner does it.`,
    fix: `set join_collapse_limit = ${Math.max(n, 12)};\nset from_collapse_limit = ${Math.max(n, 12)};${geqo ? `\nset geqo_threshold = ${n + 1};` : ''}`,
    fixNote: 'Planning time grows quickly with the limit; compare the planning time in the summary before and after.' })
}

function notIn(ctx: Ctx) {
  if (!ctx.facts?.notInSubquery.length) return
  const node = ctx.plan.nodes.find(n => /hashed SubPlan|SubPlan/.test(String(n.raw['Filter'] ?? ''))) ?? null
  add(ctx, { id: 'not-in', severity: 'medium', category: 'rewrite', nodeId: node?.id ?? null, title: 'NOT IN (subquery) blocks the anti-join',
    detail: `NOT IN has to handle NULL specially: if the subquery returns any NULL the whole condition is unknown and no rows match. Because of that the planner cannot turn it into an anti-join and instead builds the subquery result and probes it per row (a hashed SubPlan), which falls back to a per-row rescan when the result exceeds work_mem.\n\nNOT EXISTS has the same meaning when the column is NOT NULL and is planned as a proper anti-join with index support.`,
    fix: `-- where x not in (select y from t where ...)\nwhere not exists (select 1 from t where t.y = outer.x and ...)` })
}

function offsetPagination(ctx: Ctx) {
  const off = ctx.facts?.offset ?? null
  if (off === null || off < 1000) return
  const node = ctx.plan.nodes.find(n => n.type === 'Limit') ?? null
  add(ctx, { id: 'offset', severity: off >= 100000 ? 'high' : 'medium', category: 'rewrite', nodeId: node?.id ?? null, title: `OFFSET ${fmtNum(off)} reads and discards ${fmtNum(off)} rows`,
    detail: `OFFSET does not skip rows; the server produces the first ${fmtNum(off)} in order and throws them away, so each later page costs more than the one before.\n\nKeyset pagination remembers the sort key of the last row shown and asks for rows after it, which an index answers directly at any depth.`,
    fix: `-- instead of: order by id limit 20 offset ${off}\n-- where id > :last_seen_id order by id limit 20` })
}

function outerWhere(ctx: Ctx) {
  for (const w of ctx.facts?.outerWhere ?? []) {
    // The planner reports what it did: if an outer join over this alias survived, the predicate did not convert it.
    const stillOuter = ctx.plan.nodes.some(n => joinTypes.has(n.type) && ['Left', 'Right', 'Full'].includes(String(n.raw['Join Type'])) && aliasesUnder(n).has(w.alias))
    if (stillOuter) continue
    add(ctx, { id: 'outer-where', severity: 'low', category: 'rewrite', nodeId: null, title: `WHERE on ${w.alias} turns the outer join into an inner join`,
      detail: `${w.alias} is on the nullable side of an outer join, but the WHERE clause requires ${w.text}. Rows with no match have NULL there and fail the condition, so the outer join behaves as an inner join (the planner has already converted it).\n\nIf that is the intent, write INNER JOIN so the query says what it does. If unmatched rows should be kept, move the condition into the ON clause.` })
  }
}

function selectStar(ctx: Ctx) {
  if (!ctx.facts?.selectStar) return
  const wide = ctx.plan.nodes.some(n => (n.type === 'Sort' || n.type === 'Hash' || n.type === 'Materialize' || n.type === 'Incremental Sort') && num(n.raw['Plan Width']) >= 100 && tot(ctx, n) >= 10000)
  if (!wide) return
  add(ctx, { id: 'select-star', severity: 'low', category: 'rewrite', nodeId: null, title: 'SELECT * carries wide rows through sorts and hashes',
    detail: 'Every column is fetched and copied through each sort, hash or materialise step. Listing only the columns needed shrinks the rows in those steps and can turn an index scan into an index-only scan.' })
}

function jitTime(ctx: Ctx) {
  const p = ctx.plan
  const jit = p.jit?.Timing?.Total
  if (!p.analyze || !jit || !p.executionTime) return
  if (jit < p.executionTime * 0.2 || jit < 5) return
  add(ctx, { id: 'jit', severity: jit >= p.executionTime * 0.5 ? 'high' : 'medium', category: 'config', nodeId: null, title: `JIT compilation took ${pct(jit / p.executionTime)} of the run time`,
    detail: `Just-in-time compilation spent ${jit.toFixed(1)} ms generating code for a query that ran for ${p.executionTime.toFixed(1)} ms. The planner enables it when the estimated cost crosses jit_above_cost, which is often wrong for short queries with inflated estimates.`,
    fix: `set jit = off;  -- for this session or role`, fixNote: 'Or raise jit_above_cost so only genuinely expensive queries are compiled.' })
}

function triggerTime(ctx: Ctx) {
  const p = ctx.plan
  if (!p.analyze || !p.triggers?.length || !p.executionTime) return
  const total = p.triggers.reduce((s: number, t: any) => s + num(t.Time), 0)
  if (total < p.executionTime * 0.2) return
  const names = p.triggers.map((t: any) => `${t['Trigger Name']}${t.Relation ? ' on ' + t.Relation : ''} (${num(t.Time).toFixed(1)} ms, ${fmtNum(num(t.Calls))} calls)`).join('; ')
  add(ctx, { id: 'triggers', severity: total >= p.executionTime * 0.5 ? 'high' : 'medium', category: 'rewrite', nodeId: null, title: `Triggers account for ${pct(total / p.executionTime)} of the run time`,
    detail: `${names}.\n\nForeign key checks appear here as RI_ConstraintTrigger entries; a missing index on the referencing column makes each check a sequential scan.` })
}

function planningTime(ctx: Ctx) {
  const p = ctx.plan
  if (p.planningTime === null || p.planningTime < 10) return
  const exec = p.executionTime ?? 0
  if (p.analyze && p.planningTime < exec) return
  add(ctx, { id: 'planning-time', severity: 'low', category: 'config', nodeId: null, title: `Planning took ${p.planningTime.toFixed(1)} ms${p.analyze ? `, longer than execution (${exec.toFixed(1)} ms)` : ''}`,
    detail: 'Planning cost is paid on every execution unless the statement is prepared. Many joins, many partitions, or many indexes on the tables all make planning slower.\n\nA prepared statement (or a driver that uses them) caches the plan after a few runs; plan_cache_mode = force_generic_plan skips per-call planning entirely when the parameter values do not change the best plan.' })
}
