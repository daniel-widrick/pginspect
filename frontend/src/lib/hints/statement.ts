// Statement-level observations: too many tables for the join planner, JIT,
// triggers and planning time out of proportion to execution.
import { pct } from '../plan'
import { add, alias, fmtNum, num, type Ctx } from './ctx'

export function joinCollapse(ctx: Ctx) {
  const n = ctx.facts ? ctx.facts.relations.filter(r => !r.derived).length : new Set(ctx.plan.nodes.filter(m => m.raw['Relation Name'] && m.raw['Parent Relationship'] !== 'SubPlan' && m.raw['Parent Relationship'] !== 'InitPlan').map(m => alias(m))).size
  if (n <= 8) return
  const geqo = n >= 12
  add(ctx, { id: 'join-collapse', severity: geqo ? 'high' : 'medium', category: 'config', nodeId: null, title: `${n} tables: join order is ${geqo ? 'searched heuristically' : 'partly fixed by how the query is written'}`,
    detail: `The query joins ${n} relations. Above join_collapse_limit (default 8) the planner stops considering every join order and keeps the order the FROM clause is written in across that boundary${geqo ? ', and at geqo_threshold (default 12) it switches to a genetic search that samples orders rather than comparing them all' : ''}.\n\nThis is where the written order matters: put the most restrictive table and its joins first so the early joins produce the fewest rows. Or raise the limits for this session so the planner does it.`,
    fix: `set join_collapse_limit = ${Math.max(n, 12)};\nset from_collapse_limit = ${Math.max(n, 12)};${geqo ? `\nset geqo_threshold = ${n + 1};` : ''}`,
    fixNote: 'Planning time grows quickly with the limit; compare the planning time in the summary before and after.' })
}

export function jitTime(ctx: Ctx) {
  const p = ctx.plan
  const jit = p.jit?.Timing?.Total
  if (!p.analyze || !jit || !p.executionTime) return
  if (jit < p.executionTime * 0.2 || jit < 5) return
  add(ctx, { id: 'jit', severity: jit >= p.executionTime * 0.5 ? 'high' : 'medium', category: 'config', nodeId: null, title: `JIT compilation took ${pct(jit / p.executionTime)} of the run time`,
    detail: `Just-in-time compilation spent ${jit.toFixed(1)} ms generating code for a query that ran for ${p.executionTime.toFixed(1)} ms. The planner enables it when the estimated cost crosses jit_above_cost, which is often wrong for short queries with inflated estimates.`,
    fix: `set jit = off;  -- for this session or role`, fixNote: 'Or raise jit_above_cost so only genuinely expensive queries are compiled.' })
}

export function triggerTime(ctx: Ctx) {
  const p = ctx.plan
  if (!p.analyze || !p.triggers?.length || !p.executionTime) return
  const total = p.triggers.reduce((s: number, t: any) => s + num(t.Time), 0)
  if (total < p.executionTime * 0.2) return
  const names = p.triggers.map((t: any) => `${t['Trigger Name']}${t.Relation ? ' on ' + t.Relation : ''} (${num(t.Time).toFixed(1)} ms, ${fmtNum(num(t.Calls))} calls)`).join('; ')
  add(ctx, { id: 'triggers', severity: total >= p.executionTime * 0.5 ? 'high' : 'medium', category: 'rewrite', nodeId: null, title: `Triggers account for ${pct(total / p.executionTime)} of the run time`,
    detail: `${names}.\n\nForeign key checks appear here as RI_ConstraintTrigger entries; a missing index on the referencing column makes each check a sequential scan.` })
}

export function planningTime(ctx: Ctx) {
  const p = ctx.plan
  if (p.planningTime === null || p.planningTime < 10) return
  const exec = p.executionTime ?? 0
  if (p.analyze && p.planningTime < exec) return
  add(ctx, { id: 'planning-time', severity: 'low', category: 'config', nodeId: null, title: `Planning took ${p.planningTime.toFixed(1)} ms${p.analyze ? `, longer than execution (${exec.toFixed(1)} ms)` : ''}`,
    detail: 'Planning cost is paid on every execution unless the statement is prepared. Many joins, many partitions, or many indexes on the tables all make planning slower.\n\nA prepared statement (or a driver that uses them) caches the plan after a few runs; plan_cache_mode = force_generic_plan skips per-call planning entirely when the parameter values do not change the best plan.' })
}
