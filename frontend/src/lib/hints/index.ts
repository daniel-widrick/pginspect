// Optimisation hints derived from an EXPLAIN plan, optionally combined with
// facts from the statement's parse tree. Everything here is deterministic:
// each rule looks for a known shape (a filter applied after a join, a hash
// built from an unfiltered table, a sort spilling to disk) and names the fix.
//
// The rules live in modules by what they look at: scans, estimates, joins,
// subqueries, memory, and the statement as a whole.
import type { ParsedPlan, PlanNode } from '../plan'
import { computeRows, dedupe, rowFlow, type Ctx } from './ctx'
import { misestimate } from './estimates'
import { crossJoin, driveFromBigSide, fanOut, lateFilter } from './joins'
import { hashBatches, heapFetches, lossyBitmap, sortHints, workersShort } from './memory'
import { indexThenFilter, repeatedScan, seqScanFilter } from './scans'
import { jitTime, joinCollapse, planningTime, triggerTime } from './statement'
import { cteFence, notIn, offsetPagination, outerWhere, selectStar, subPlanPerRow } from './subqueries'
import type { Analysis, AnalyzeOptions, Severity } from './types'

export type { Analysis, AnalyzeOptions, Category, FlowStep, Hint, Severity } from './types'
export { textPredicates } from './text'

/** Rules that look at one plan node, in the order their hints should be considered. */
const nodeRules: ((ctx: Ctx, n: PlanNode) => void)[] = [
  seqScanFilter, indexThenFilter, repeatedScan, misestimate, driveFromBigSide, lateFilter, cteFence, fanOut,
  subPlanPerRow, crossJoin, sortHints, hashBatches, lossyBitmap, heapFetches, workersShort,
]

/** Rules that look at the statement or the plan as a whole. */
const planRules: ((ctx: Ctx) => void)[] = [joinCollapse, notIn, offsetPagination, outerWhere, selectStar, jitTime, triggerTime, planningTime]

export function analyzePlan(plan: ParsedPlan, opts: AnalyzeOptions = {}): Analysis {
  const ctx: Ctx = {
    plan, facts: opts.facts ?? null, serverMajor: opts.serverMajor ?? 0, schemaOf: opts.schemaOf ?? (() => null),
    tot: new Map(), removed: new Map(), rowsIn: new Map(), parent: new Map(), hints: [],
  }
  computeRows(ctx)
  const flow = rowFlow(ctx)
  for (const n of plan.nodes) for (const rule of nodeRules) rule(ctx, n)
  for (const rule of planRules) rule(ctx)

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
  const hints = dedupe(ctx.hints).sort((a, b) => order[a.severity] - order[b.severity])
  return { hints, flow, relations: relationCount(ctx) }
}

/** Base relations in the query: from the parse tree when there is one, else the distinct scanned tables. */
function relationCount(ctx: Ctx): number {
  if (ctx.facts) return ctx.facts.relations.filter(r => !r.derived).length
  return new Set(ctx.plan.nodes.filter(n => n.raw['Relation Name']).map(n => n.raw['Alias'] ?? n.raw['Relation Name'])).size
}
