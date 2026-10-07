// Rules about subqueries and statement shape: a CTE or subquery filtered
// after being computed, a correlated subquery per row, NOT IN, OFFSET
// pagination, WHERE on an outer join's nullable side, and SELECT *.
import type { PlanNode } from '../plan'
import { pct } from '../plan'
import type { Cte } from '../sqlast'
import { add, alias, aliasesUnder, fmtNum, joinTypes, label, num, removed, share, tot, type Ctx } from './ctx'
import type { Hint, Severity } from './types'

export function cteFence(ctx: Ctx, n: PlanNode) {
  if (n.type !== 'CTE Scan' && n.type !== 'Subquery Scan') return
  const text = n.raw['Filter']
  if (!text) return
  const rem = removed(ctx, n), out = tot(ctx, n)
  if (ctx.plan.analyze ? rem < 1000 || rem < out : share(ctx, n) < 0.1) return
  const amount = ctx.plan.analyze ? `${fmtNum(rem + out)} rows were produced and ${fmtNum(rem)} (${pct(rem / Math.max(1, rem + out))}) then discarded by ${text}` : `the filter ${text} is applied to its output`
  const severity: Severity = rem >= 100000 ? 'high' : 'medium'
  if (n.type === 'CTE Scan') add(ctx, cteFenceHint(ctx, n, amount, severity))
  else add(ctx, { id: 'subquery-fence', severity, category: 'rewrite', nodeId: n.id, title: 'Subquery is filtered after being fully computed',
    detail: `${amount}.\n\nThe subquery could not be flattened into the outer query (it has DISTINCT, GROUP BY, LIMIT, a window function, or a set operation), so its filter runs on the finished result. Put the condition inside the subquery.` })
}

function cteFenceHint(ctx: Ctx, n: PlanNode, amount: string, severity: Severity): Hint {
  const name = String(n.raw['CTE Name'] ?? '?')
  const cte = ctx.facts?.ctes.find(c => c.name === name)
  return { id: 'cte-fence', severity, category: 'rewrite', nodeId: n.id, title: `CTE ${name} is filtered after being fully computed`,
    detail: `${amount}.\n\n${cteMaterialisedWhy(ctx, name, cte)} Moving the condition into the CTE, or letting Postgres inline it, restricts the rows where they are read.`,
    fix: cte?.materialized === 'always' ? `with ${name} as not materialized (...)` : `with ${name} as (select ... where <the condition that is now outside>)`,
    fixNote: 'NOT MATERIALIZED needs Postgres 12+. A CTE referenced once is inlined by default from 12 on unless it is recursive or has side effects.' }
}

/** Why the CTE was computed in full before the outer filter could reach it. */
function cteMaterialisedWhy(ctx: Ctx, name: string, cte: Cte | undefined): string {
  if (ctx.serverMajor && ctx.serverMajor < 12) return `Before Postgres 12 every CTE is materialised, so ${name} is computed in full before the outer query filters it.`
  if (cte?.materialized === 'always') return `${name} is declared MATERIALIZED, so it is computed in full before the outer query filters it.`
  if (cte && cte.refs > 1) return `${name} is referenced ${cte.refs} times, so Postgres materialises it rather than inlining it, and the outer filter cannot reach inside.`
  return `${name} was materialised (it is recursive, has side effects, or is referenced more than once), so the outer filter cannot reach inside it.`
}

export function subPlanPerRow(ctx: Ctx, n: PlanNode) {
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

export function notIn(ctx: Ctx) {
  if (!ctx.facts?.notInSubquery.length) return
  const node = ctx.plan.nodes.find(n => /hashed SubPlan|SubPlan/.test(String(n.raw['Filter'] ?? ''))) ?? null
  add(ctx, { id: 'not-in', severity: 'medium', category: 'rewrite', nodeId: node?.id ?? null, title: 'NOT IN (subquery) blocks the anti-join',
    detail: `NOT IN has to handle NULL specially: if the subquery returns any NULL the whole condition is unknown and no rows match. Because of that the planner cannot turn it into an anti-join and instead builds the subquery result and probes it per row (a hashed SubPlan), which falls back to a per-row rescan when the result exceeds work_mem.\n\nNOT EXISTS has the same meaning when the column is NOT NULL and is planned as a proper anti-join with index support.`,
    fix: `-- where x not in (select y from t where ...)\nwhere not exists (select 1 from t where t.y = outer.x and ...)` })
}

export function offsetPagination(ctx: Ctx) {
  const off = ctx.facts?.offset ?? null
  if (off === null || off < 1000) return
  const node = ctx.plan.nodes.find(n => n.type === 'Limit') ?? null
  add(ctx, { id: 'offset', severity: off >= 100000 ? 'high' : 'medium', category: 'rewrite', nodeId: node?.id ?? null, title: `OFFSET ${fmtNum(off)} reads and discards ${fmtNum(off)} rows`,
    detail: `OFFSET does not skip rows; the server produces the first ${fmtNum(off)} in order and throws them away, so each later page costs more than the one before.\n\nKeyset pagination remembers the sort key of the last row shown and asks for rows after it, which an index answers directly at any depth.`,
    fix: `-- instead of: order by id limit 20 offset ${off}\n-- where id > :last_seen_id order by id limit 20` })
}

export function outerWhere(ctx: Ctx) {
  for (const w of ctx.facts?.outerWhere ?? []) {
    // The planner reports what it did: if an outer join over this alias survived, the predicate did not convert it.
    const stillOuter = ctx.plan.nodes.some(n => joinTypes.has(n.type) && ['Left', 'Right', 'Full'].includes(String(n.raw['Join Type'])) && aliasesUnder(n).has(w.alias))
    if (stillOuter) continue
    add(ctx, { id: 'outer-where', severity: 'low', category: 'rewrite', nodeId: null, title: `WHERE on ${w.alias} turns the outer join into an inner join`,
      detail: `${w.alias} is on the nullable side of an outer join, but the WHERE clause requires ${w.text}. Rows with no match have NULL there and fail the condition, so the outer join behaves as an inner join (the planner has already converted it).\n\nIf that is the intent, write INNER JOIN so the query says what it does. If unmatched rows should be kept, move the condition into the ON clause.` })
  }
}

export function selectStar(ctx: Ctx) {
  if (!ctx.facts?.selectStar) return
  const wide = ctx.plan.nodes.some(n => (n.type === 'Sort' || n.type === 'Hash' || n.type === 'Materialize' || n.type === 'Incremental Sort') && num(n.raw['Plan Width']) >= 100 && tot(ctx, n) >= 10000)
  if (!wide) return
  add(ctx, { id: 'select-star', severity: 'low', category: 'rewrite', nodeId: null, title: 'SELECT * carries wide rows through sorts and hashes',
    detail: 'Every column is fetched and copied through each sort, hash or materialise step. Listing only the columns needed shrinks the rows in those steps and can turn an index scan into an index-only scan.' })
}

