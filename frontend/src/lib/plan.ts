// Turns EXPLAIN (FORMAT JSON) output into a flat, annotated node list.

export interface PlanNode {
  id: number
  depth: number
  raw: Record<string, any>
  type: string
  /** What the node acts on: relation, index, keys, condition summary. */
  detail: string
  /** Parent Relationship / Subplan Name, e.g. "InitPlan 1 (returns $0)". */
  role: string
  children: PlanNode[]
  planRows: number
  actualRows: number | null
  loops: number
  /** Inclusive and exclusive time in ms, summed over loops. Null without ANALYZE. */
  inclTime: number | null
  exclTime: number | null
  totalCost: number
  exclCost: number
  warnings: string[]
}

export interface ParsedPlan {
  root: PlanNode
  nodes: PlanNode[]
  analyze: boolean
  planningTime: number | null
  executionTime: number | null
  totalTime: number | null
  totalCost: number
  sharedHit: number
  sharedRead: number
  tempWritten: number
  settings: Record<string, string> | null
  triggers: any[] | null
  jit: any | null
  warnings: { node: PlanNode; text: string }[]
}

export function parsePlan(json: string): ParsedPlan {
  const doc = JSON.parse(json)
  const top = Array.isArray(doc) ? doc[0] : doc
  if (!top?.Plan) throw new Error('No "Plan" element in EXPLAIN output')
  const nodes: PlanNode[] = []
  let id = 0

  // Below a Gather, each worker reports its own loops and times; they run
  // concurrently, so wall-clock contribution is the per-worker figure.
  const build = (raw: any, depth: number, workers: number): PlanNode => {
    const node: PlanNode = {
      id: id++, depth, raw,
      type: raw['Node Type'] ?? '?',
      detail: describe(raw),
      role: role(raw),
      children: [],
      planRows: num(raw['Plan Rows']),
      actualRows: raw['Actual Rows'] === undefined ? null : num(raw['Actual Rows']),
      loops: raw['Actual Loops'] === undefined ? 1 : Math.max(1, num(raw['Actual Loops'])),
      inclTime: null, exclTime: null,
      totalCost: num(raw['Total Cost']),
      exclCost: 0,
      warnings: [],
    }
    nodes.push(node)
    const childWorkers = node.type === 'Gather' || node.type === 'Gather Merge'
      ? 1 + num(raw['Workers Launched'] ?? raw['Workers Planned'])
      : workers
    node.children = (raw.Plans ?? []).map((c: any) => build(c, depth + 1, childWorkers))
    if (raw['Actual Total Time'] !== undefined) {
      node.inclTime = num(raw['Actual Total Time']) * node.loops / Math.max(1, workers)
      const childTime = node.children.reduce((s, c) => s + (c.inclTime ?? 0), 0)
      node.exclTime = Math.max(0, node.inclTime - childTime)
    }
    const childCost = node.children.reduce((s, c) => s + c.totalCost, 0)
    node.exclCost = Math.max(0, node.totalCost - childCost)
    node.warnings = warn(node)
    return node
  }

  const root = build(top.Plan, 0, 1)
  const analyze = root.inclTime !== null
  const warnings = nodes.flatMap(n => n.warnings.map(text => ({ node: n, text })))
  return {
    root, nodes, analyze,
    planningTime: top['Planning Time'] ?? null,
    executionTime: top['Execution Time'] ?? null,
    totalTime: root.inclTime,
    totalCost: root.totalCost,
    sharedHit: num(root.raw['Shared Hit Blocks']),
    sharedRead: num(root.raw['Shared Read Blocks']),
    tempWritten: num(root.raw['Temp Written Blocks']),
    settings: top.Settings ?? null,
    triggers: top.Triggers ?? null,
    jit: top.JIT ?? null,
    warnings,
  }
}

function num(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function role(raw: any): string {
  const rel = raw['Parent Relationship']
  if (raw['Subplan Name']) return raw['Subplan Name']
  if (rel && rel !== 'Outer' && rel !== 'Inner' && rel !== 'Member') return rel
  return ''
}

// Each builder contributes one fragment of a node's one-line description, or
// nothing. Order is display order, except Operation which leads.
const describers: ((raw: any) => string | null)[] = [
  raw => raw['Index Name'] ? `using ${raw['Index Name']}` : null,
  raw => {
    const rel = raw['Relation Name']
    if (rel) {
      const alias = raw['Alias'] && raw['Alias'] !== rel ? ` as ${raw['Alias']}` : ''
      return `on ${raw['Schema'] ? raw['Schema'] + '.' : ''}${rel}${alias}`
    }
    return raw['Alias'] && !['Hash', 'Sort', 'Limit'].includes(raw['Node Type'] ?? '') ? raw['Alias'] : null
  },
  raw => raw['CTE Name'] ? `cte ${raw['CTE Name']}` : null,
  raw => raw['Function Name'] ?? null,
  raw => raw['Join Type'] && raw['Join Type'] !== 'Inner' ? raw['Join Type'].toLowerCase() : null,
  raw => raw['Strategy'] && raw['Strategy'] !== 'Plain' ? raw['Strategy'].toLowerCase() : null,
  raw => raw['Partial Mode'] && raw['Partial Mode'] !== 'Simple' ? raw['Partial Mode'].toLowerCase() : null,
  raw => raw['Sort Key'] ? `by ${asList(raw['Sort Key'])}` : null,
  raw => raw['Group Key'] ? `by ${asList(raw['Group Key'])}` : null,
  raw => {
    if (raw['Workers Launched'] !== undefined) return `${raw['Workers Launched']}/${raw['Workers Planned']} workers`
    return raw['Workers Planned'] !== undefined ? `${raw['Workers Planned']} workers` : null
  },
  raw => raw['Scan Direction'] === 'Backward' ? 'backward' : null,
]

function describe(raw: any): string {
  const parts = describers.map(d => d(raw)).filter((p): p is string => p !== null)
  if (raw['Operation']) parts.unshift(raw['Operation'].toLowerCase())
  return parts.join(' ')
}

function asList(v: any): string {
  return Array.isArray(v) ? v.join(', ') : String(v)
}

// Each check reads one symptom off a node and words it for the tree view.
const warnChecks: ((n: PlanNode, r: Record<string, any>, sofar: string[]) => string | null)[] = [
  n => {
    if (n.actualRows === null) return null
    const est = Math.max(n.planRows, 1)
    const act = Math.max(n.actualRows, 1)
    const factor = act > est ? act / est : est / act
    if (factor < 10 || Math.max(n.actualRows, n.planRows) < 100) return null
    return `rows ${act > est ? 'under' : 'over'}estimated ${factor >= 100 ? Math.round(factor) : factor.toFixed(1)}x`
  },
  (n, r) => {
    const removed = num(r['Rows Removed by Filter'])
    if (removed > 0 && n.actualRows !== null && removed >= 1000 && removed > n.actualRows * 5) return `filter discards ${pct(removed / (removed + n.actualRows))} of rows scanned`
    return null
  },
  (_, r) => r['Sort Space Type'] === 'Disk' ? `sort spills to disk (${num(r['Sort Space Used'])} kB)` : null,
  (_, r) => num(r['Hash Batches']) > 1 ? `hash uses ${r['Hash Batches']} batches (work_mem too small)` : null,
  (_, r, sofar) => num(r['Temp Written Blocks']) > 0 && !sofar.some(w => w.includes('disk') || w.includes('batches')) ? 'writes temp blocks' : null,
  (_, r) => num(r['Lossy Heap Blocks']) > 0 ? `lossy bitmap (${r['Lossy Heap Blocks']} heap blocks)` : null,
  (n, r) => {
    if (n.type !== 'Index Only Scan' || n.actualRows === null) return null
    return num(r['Heap Fetches']) > 0 && num(r['Heap Fetches']) > n.actualRows * 0.5 ? `${r['Heap Fetches']} heap fetches (visibility map stale, run VACUUM)` : null
  },
  (_, r) => r['Workers Launched'] !== undefined && num(r['Workers Launched']) < num(r['Workers Planned']) ? `only ${r['Workers Launched']} of ${r['Workers Planned']} workers launched` : null,
]

function warn(n: PlanNode): string[] {
  const out: string[] = []
  for (const check of warnChecks) {
    const w = check(n, n.raw, out)
    if (w) out.push(w)
  }
  return out
}

export function pct(f: number): string {
  f = Math.max(0, Math.min(1, f))
  if (f > 0.99 && f < 1) return `${(f * 100).toFixed(1)}%`
  return `${Math.round(f * 100)}%`
}

export function fmtMs(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1) return `${ms.toFixed(3)} ms`
  if (ms < 1000) return `${ms.toFixed(1)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function fmtNum(n: number | null): string {
  return n === null ? '' : n.toLocaleString()
}

/** Scalar attributes worth showing in the detail view, in a stable order. */
const hidden = new Set(['Node Type', 'Plans', 'Plan Rows', 'Actual Rows', 'Actual Loops', 'Startup Cost', 'Total Cost',
  'Actual Startup Time', 'Actual Total Time', 'Plan Width', 'Parallel Aware', 'Async Capable', 'Parent Relationship'])
export function detailEntries(raw: Record<string, any>): [string, string][] {
  return Object.entries(raw)
    .filter(([k]) => !hidden.has(k))
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string])
}
