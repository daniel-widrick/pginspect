// The analysis context: the plan, the parse-tree facts, the row accounting
// every rule reads, and the small helpers they share.
import type { ParsedPlan, PlanNode } from '../plan'
import { fmtNum as fmtExact } from '../plan'
import type { SqlFacts } from '../sqlast'
import { quoteIdent } from '../sqlast'
import type { FlowStep, Hint } from './types'

export const fmtNum = (n: number | null) => fmtExact(n === null ? null : Math.round(n))

export const scanTypes = new Set(['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan', 'Tid Scan', 'Tid Range Scan', 'Foreign Scan', 'Sample Scan'])
export const joinTypes = new Set(['Nested Loop', 'Hash Join', 'Merge Join'])
export const passThrough = new Set(['Materialize', 'Memoize', 'Gather', 'Gather Merge', 'Hash', 'Sort', 'Incremental Sort', 'Result', 'Subquery Scan'])
export const collapseTypes = new Set(['Aggregate', 'Unique', 'Group', 'HashAggregate', 'GroupAggregate'])

export interface Ctx {
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

export function add(ctx: Ctx, h: Hint) { ctx.hints.push(h) }

export function dedupe(hints: Hint[]): Hint[] {
  const seen = new Set<string>()
  return hints.filter(h => {
    const k = h.id + '|' + (h.fix ?? h.title)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ---- row accounting ------------------------------------------------------

/** Total rows each node produced across all loops, and rows its filters discarded. */
export function computeRows(ctx: Ctx) {
  const analyze = ctx.plan.analyze
  const walk = (n: PlanNode, mult: number, workers: number) => {
    for (const c of n.children) ctx.parent.set(c.id, n)
    const rows = analyze ? (n.actualRows ?? 0) * n.loops : n.planRows * mult * workers
    ctx.tot.set(n.id, rows)
    const loops = analyze ? n.loops : mult * workers
    const removed = removedRows(n, analyze)
    ctx.removed.set(n.id, removed)
    const workersBelow = childWorkers(n, analyze, workers)
    const st: WalkState = { analyze, mult, rows, loops }
    for (const c of n.children) walk(c, childMultiplier(ctx, n, c, st), workersBelow)
    liftInnerLoopRows(ctx, n, rows, analyze)
    ctx.rowsIn.set(n.id, inputRows(ctx, n, rows, removed))
  }
  walk(ctx.plan.root, 1, 1)
}

/** Rows a node's own filters threw away, over every loop when measured. */
function removedRows(n: PlanNode, analyze: boolean): number {
  const perLoop = num(n.raw['Rows Removed by Filter']) + num(n.raw['Rows Removed by Join Filter']) + num(n.raw['Rows Removed by Index Recheck'])
  return perLoop * (analyze ? n.loops : 1)
}

/** Parallel children report per-worker estimates; scale them back up. */
function childWorkers(n: PlanNode, analyze: boolean, workers: number): number {
  if (analyze || (n.type !== 'Gather' && n.type !== 'Gather Merge')) return workers
  const w = num(n.raw['Workers Planned'])
  const leader = 1 - 0.3 * w
  return w + (leader > 0 ? leader : 0)
}

/** What the row walk knows at a node when it descends: measured or estimated, and the multipliers so far. */
interface WalkState { analyze: boolean; mult: number; rows: number; loops: number }

/** How many times an estimated child runs: once per outer row under a nested loop, once per loop for a subplan. */
function childMultiplier(ctx: Ctx, n: PlanNode, c: PlanNode, st: WalkState): number {
  if (st.analyze) return st.mult
  const rel = c.raw['Parent Relationship']
  if (n.type === 'Nested Loop' && rel === 'Inner') return Math.max(1, st.rows > 0 ? ctx.tot.get(n.children[0].id) ?? 1 : 1)
  if (rel === 'SubPlan') return Math.max(1, st.loops)
  return st.mult
}

/** A measured nested loop's inner side produced at least the join's output; the reported figure can understate it. */
function liftInnerLoopRows(ctx: Ctx, n: PlanNode, rows: number, analyze: boolean): void {
  if (!analyze || n.type !== 'Nested Loop') return
  if (!['Inner', 'Semi'].includes(String(n.raw['Join Type'] ?? 'Inner'))) return
  const inner = n.children.find(c => c.raw['Parent Relationship'] === 'Inner')
  if (inner && (ctx.tot.get(inner.id) ?? 0) < rows) ctx.tot.set(inner.id, rows)
}

/** Rows that reached a node: the sum of its inputs, or for a leaf what it read. */
function inputRows(ctx: Ctx, n: PlanNode, rows: number, removed: number): number {
  const inputs = n.children.filter(isInput)
  if (inputs.length === 0) return rows + removed
  return inputs.reduce((s, c) => s + (ctx.tot.get(c.id) ?? 0), 0)
}

export function isInput(c: PlanNode): boolean {
  const rel = c.raw['Parent Relationship']
  return rel !== 'InitPlan' && rel !== 'SubPlan'
}

export function rowFlow(ctx: Ctx): FlowStep[] {
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

export function num(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function tot(ctx: Ctx, n: PlanNode): number { return ctx.tot.get(n.id) ?? 0 }
export function removed(ctx: Ctx, n: PlanNode): number { return ctx.removed.get(n.id) ?? 0 }
export function rowsIn(ctx: Ctx, n: PlanNode): number { return ctx.rowsIn.get(n.id) ?? 0 }

export function share(ctx: Ctx, n: PlanNode): number {
  const p = ctx.plan
  if (p.analyze) return p.totalTime ? (n.exclTime ?? 0) / p.totalTime : 0
  return p.totalCost ? n.exclCost / p.totalCost : 0
}

export function alias(n: PlanNode): string | null {
  return n.raw['Alias'] ?? n.raw['Relation Name'] ?? null
}

/** Schema-qualified table name for a scan node, using the query text when it names the schema. */
export function tableName(ctx: Ctx, n: PlanNode): string {
  const rel = n.raw['Relation Name'] ?? '?'
  const a = alias(n)
  const fromSql = ctx.facts?.relations.find(r => r.alias === a && r.name === rel)
  const schema = n.raw['Schema'] ?? fromSql?.schema ?? ctx.schemaOf(rel)
  return (schema ? quoteIdent(schema) + '.' : '') + quoteIdent(rel)
}

export function label(n: PlanNode): string {
  return n.type + (n.detail ? ' ' + n.detail : '')
}

/** Aliases referenced as alias.column in a plan expression. */
export function aliasRefs(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of stripStrings(text).matchAll(/(?<![\w."])("[^"]+"|[A-Za-z_][\w$]*)\.(?:"[^"]+"|[A-Za-z_][\w$]*)/g)) out.add(m[1].replace(/^"|"$/g, ''))
  return out
}

export function stripStrings(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, "''")
}

/** Finds the scan feeding a join input, looking through Hash, Materialize, Gather and Memoize. */
export function scanUnder(n: PlanNode): PlanNode | null {
  let cur: PlanNode | null = n
  while (cur) {
    if (scanTypes.has(cur.type)) return cur
    if (!passThrough.has(cur.type) || cur.children.length !== 1) return null
    cur = cur.children[0]
  }
  return null
}

export function hasCond(n: PlanNode): boolean {
  return ['Filter', 'Index Cond', 'Recheck Cond', 'TID Cond'].some(k => n.raw[k] !== undefined) || n.children.some(c => c.type === 'Bitmap Index Scan')
}

export function aliasesUnder(n: PlanNode): Set<string> {
  const out = new Set<string>()
  const walk = (m: PlanNode) => { const a = alias(m); if (a && m.raw['Relation Name']) out.add(a); m.children.forEach(walk) }
  walk(n)
  return out
}

/** Conditions of the given kinds found anywhere below a node. */
export function descendantConds(n: PlanNode, keys: string[]): string[] {
  const out: string[] = []
  const walk = (m: PlanNode) => {
    for (const k of keys) if (m.raw[k]) out.push(String(m.raw[k]))
    m.children.forEach(walk)
  }
  walk(n)
  return out
}

/** Index and join conditions below a node, which is where a parameterised join key shows up. */
export const joinCondKeys = ['Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond']
export const allCondKeys = ['Index Cond', 'Recheck Cond', 'Filter', 'Join Filter', 'Hash Cond', 'Merge Cond']
