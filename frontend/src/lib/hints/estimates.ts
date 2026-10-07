// Row estimates that were badly wrong, on a scan (statistics) or on a join
// whose inputs were fine (the join itself was misjudged).
import type { PlanNode } from '../plan'
import { quoteIdent } from '../sqlast'
import { add, alias, fmtNum, isInput, joinTypes, tableName, type Ctx } from './ctx'
import { textPredicates } from './text'
import type { Severity } from './types'

const quiet = new Set(['Hash', 'Materialize', 'Memoize', 'Gather', 'Gather Merge'])

export function misestimate(ctx: Ctx, n: PlanNode) {
  if (n.actualRows === null || quiet.has(n.type)) return
  const { factor, under } = estimateError(n.planRows, n.actualRows)
  if (factor < 5 || Math.max(n.actualRows, n.planRows) < 1000) return
  const f = factor >= 100 ? `${Math.round(factor)}x` : `${factor.toFixed(1)}x`
  const severity: Severity = factor >= 50 ? 'high' : 'medium'
  if (n.raw['Relation Name']) scanMisestimate(ctx, n, f, under, severity)
  else if (joinTypes.has(n.type)) joinMisestimate(ctx, n, f, under)
}

/** How far off an estimate was, as a factor of at least 1, and in which direction. */
function estimateError(planned: number, actual: number): { factor: number; under: boolean } {
  const est = Math.max(planned, 1), act = Math.max(actual, 1)
  return { factor: act > est ? act / est : est / act, under: act > est }
}

function scanMisestimate(ctx: Ctx, n: PlanNode, f: string, under: boolean, severity: Severity) {
  const table = tableName(ctx, n)
  const conds = ['Index Cond', 'Recheck Cond', 'Filter'].map(k => n.raw[k]).filter(Boolean).map(String).join(' AND ')
  const preds = textPredicates(conds, alias(n)).filter(p => !p.foreign && p.op !== 'JOIN')
  const cols = [...new Set(preds.map(p => p.col.column))]
  const perLoop = n.loops > 1 ? ' per loop' : ''
  const base = `The planner expected ${fmtNum(n.planRows)} rows from ${table} and got ${fmtNum(n.actualRows)}${perLoop} (${under ? 'under' : 'over'}estimated ${f}). Bad estimates lead to the wrong join strategy and join order further up the plan.`
  if (cols.length >= 2) {
    const stat = `${(n.raw['Relation Name'] as string)}_${cols.join('_')}_stats`.replace(/[^\w]/g, '_')
    add(ctx, { id: 'ext-stats', severity, category: 'statistics', nodeId: n.id, title: `Row estimate off ${f} on ${table}: correlated columns`,
      detail: `${base}\n\nThe conditions combine ${cols.map(quoteIdent).join(' and ')}. Postgres assumes columns are independent unless extended statistics say otherwise, so correlated columns multiply into a far too small (or large) estimate.`,
      fix: `create statistics ${quoteIdent(stat)} (dependencies, ndistinct, mcv) on ${cols.map(quoteIdent).join(', ')} from ${table};\nanalyze ${table};`,
      fixNote: 'Extended statistics need Postgres 10+ (mcv needs 12+). If the estimate stays off, a higher statistics target for the columns helps: alter table ... alter column ... set statistics 1000.' })
    return
  }
  const fixNote = cols.length === 1
    ? `If ANALYZE does not fix it: alter table ${table} alter column ${quoteIdent(cols[0])} set statistics 1000; then analyze again. For an expression predicate, create statistics on the expression (Postgres 14+).`
    : 'If ANALYZE does not fix it, raise the statistics target for the filtered columns.'
  add(ctx, { id: 'analyze', severity, category: 'statistics', nodeId: n.id, title: `Row estimate off ${f} on ${table}`,
    detail: `${base}\n\nStale or coarse statistics are the usual cause. Skewed values that are not in the most-common-values list, or expressions the planner has no statistics for, also produce this.`,
    fix: `analyze ${table};`, fixNote })
}

/** Both inputs estimated well, so the join's own selectivity was the misjudgement. */
function joinMisestimate(ctx: Ctx, n: PlanNode, f: string, under: boolean) {
  const inputsOk = n.children.filter(isInput).every(c => estimateError(c.planRows, c.actualRows ?? c.planRows).factor < 3)
  if (!inputsOk) return
  const nested = n.type === 'Nested Loop' && under
  const filtered = !!(n.raw['Filter'] || n.raw['Join Filter'])
  const cause = filtered
    ? `The planner had to guess the selectivity of ${n.raw['Filter'] ?? n.raw['Join Filter']}; expressions and functions get a default guess rather than statistics.`
    : 'The planner misjudged how the join keys match up (skewed keys, or a join filter on correlated columns).'
  const perLoop = n.loops > 1 ? ' per loop' : ''
  add(ctx, { id: 'join-estimate', severity: nested ? 'high' : filtered ? 'low' : 'medium', category: 'statistics', nodeId: n.id, title: `${n.type} produced ${f} ${under ? 'more' : 'fewer'} rows than planned`,
    detail: `Both inputs were estimated well, but the join itself was expected to produce ${fmtNum(n.planRows)} rows and produced ${fmtNum(n.actualRows)}${perLoop}. ${cause}${nested ? '\n\nBecause it expected few rows it chose a nested loop, which is the worst strategy when the row count is large.' : ''}`,
    fix: nested ? `set enable_nestloop = off;  -- for this session, to test\n-- then re-run explain analyze and compare` : undefined,
    fixNote: nested ? 'If the hash or merge join is much faster, fix the estimate (statistics, extended statistics on the join columns) rather than leaving the setting off.' : undefined })
}
