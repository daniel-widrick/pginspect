// Rules about joins: reading a whole table to keep a sliver, filtering after
// the join instead of before it, multiplying rows a later step collapses,
// and a cartesian product.
import type { PlanNode } from '../plan'
import { pct } from '../plan'
import { quoteIdent } from '../sqlast'
import {
  add, aliasRefs, aliasesUnder, allCondKeys, collapseTypes, descendantConds, fmtNum, hasCond, isInput, joinCondKeys, joinTypes,
  num, scanTypes, scanUnder, stripStrings, tableName, tot, type Ctx,
} from './ctx'
import { createIndex, eqCol } from './indexing'
import { textPredicates } from './text'
import type { Hint, Severity } from './types'

// ---- drive from the big side ----------------------------------------------

/** A join that reads an entire large table while the selective condition is on the other side. */
export function driveFromBigSide(ctx: Ctx, n: PlanNode) {
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
    bigSideHint(ctx, n, { scan, other, otherScan, big, out })
  }
}

/** The unfiltered big input, the other input, and the row counts the hint quotes. */
interface BigSide { scan: PlanNode; other: PlanNode; otherScan: PlanNode | null; big: number; out: number }

function bigSideHint(ctx: Ctx, n: PlanNode, b: BigSide) {
  const { scan, other, otherScan, big, out } = b
  const table = tableName(ctx, scan)
  const own = scan.raw['Alias'] ?? scan.raw['Relation Name'] ?? null
  // Which column of the big table does the join use?
  const conds = [n.raw['Hash Cond'], n.raw['Merge Cond'], ...descendantConds(other, joinCondKeys)].filter(Boolean).map(String).join(' AND ')
  const cols = [...new Set(textPredicates(conds, null).filter(p => p.col.alias === own).map(p => p.col.column))]
  const severity: Severity = big >= 100000 ? 'high' : 'medium'
  const otherName = otherScan ? tableName(ctx, otherScan) : 'the other side'
  const keyNote = cols.length ? ` (${cols.map(quoteIdent).join(', ')})` : ''
  add(ctx, { id: 'drive-from-big-side', severity, category: 'rowflow', nodeId: n.id, title: `All ${fmtNum(big)} rows of ${table} are read to keep ${fmtNum(out)}`,
    detail: `${n.type} reads ${table} in full (${fmtNum(big)} rows, no filter) and joins it against ${otherName}, which carries the selective condition. Only ${pct(out / Math.max(1, big))} of the rows survive the join.\n\nThe restrictive condition is on the other side, so the cheaper plan starts there and looks up only the matching rows of ${table}. The planner will do that once ${table} has an index on the join key${keyNote}.`,
    fix: cols.length ? createIndex(table, cols.map(eqCol)) : undefined,
    fixNote: cols.length ? 'Foreign key columns are not indexed automatically; this is the most common missing index.' : undefined })
}

// ---- late filter ----------------------------------------------------------

interface LateFilter { key: 'Filter' | 'Join Filter'; text: string; rem: number; out: number; refs: Set<string>; hasOr: boolean; amount: string }

/** A predicate on one table evaluated at a join, after the rows were already joined. */
export function lateFilter(ctx: Ctx, n: PlanNode) {
  if (!joinTypes.has(n.type)) return
  const inputs = n.children.filter(isInput)
  if (inputs.length !== 2) return
  for (const key of ['Filter', 'Join Filter'] as const) {
    const lf = lateFilterAt(ctx, n, key)
    if (!lf) continue
    const sides = inputs.map(aliasesUnder)
    const inA = [...lf.refs].every(a => sides[0].has(a)), inB = [...lf.refs].every(a => sides[1].has(a))
    if (inA || inB) add(ctx, oneSidedLateFilter(ctx, n, lf, inA ? inputs[0] : inputs[1]))
    else if (lf.hasOr) add(ctx, orAcrossTables(n, lf))
    else if (lf.rem >= 100000) add(ctx, crossTableFilter(n, lf))
  }
}

/** The filter at this key when it discarded enough to matter, with the figures the hints quote. */
function lateFilterAt(ctx: Ctx, n: PlanNode, key: 'Filter' | 'Join Filter'): LateFilter | null {
  const text = n.raw[key]
  if (!text) return null
  const analyze = ctx.plan.analyze
  const rem = num(n.raw[key === 'Filter' ? 'Rows Removed by Filter' : 'Rows Removed by Join Filter']) * (analyze ? n.loops : 1)
  const out = tot(ctx, n)
  if (analyze && (rem < 1000 || rem < out)) return null
  if (!analyze && key === 'Join Filter') return null
  const refs = aliasRefs(String(text))
  if (!refs.size) return null
  const amount = analyze ? `${fmtNum(rem + out)} joined rows were checked and ${fmtNum(rem)} (${pct(rem / Math.max(1, rem + out))}) discarded` : 'rows are joined first and filtered afterwards'
  return { key, text: String(text), rem, out, refs, hasOr: / OR /.test(stripStrings(String(text))), amount }
}

/** The condition names only one side, so it could have run on that side's scan. Explains why it did not. */
function oneSidedLateFilter(ctx: Ctx, n: PlanNode, lf: LateFilter, side: PlanNode): Hint {
  const joinType = String(n.raw['Join Type'] ?? 'Inner')
  const rel = String(side.raw['Parent Relationship'])
  const nullable = (joinType === 'Left' && rel === 'Inner') || (joinType === 'Right' && rel === 'Outer') || joinType === 'Full'
  const tables = [...lf.refs].join(', ')
  const hint: Hint = { id: 'late-filter', severity: lf.rem >= 100000 ? 'high' : 'medium', category: 'rowflow', nodeId: n.id, title: `Condition on ${tables} is applied after the join`, detail: '' }
  let why: string
  if (nullable) {
    const written = ctx.facts?.relations.find(r => lf.refs.has(r.alias) && r.nullable) ? 'the LEFT JOIN' : 'an outer join'
    why = `${tables} is the nullable side of ${written}, so the condition cannot be pushed into its scan: applying it before the join would change which rows get NULL-extended.`
    hint.fix = `-- if unmatched rows are not wanted, the join is really inner:\n-- ... inner join ${tables} on ... where ${lf.text}\n-- if they are wanted, restrict ${tables} in a subquery and left join to that:\n-- ... left join (select ... from ${tables} where <condition>) ${tables} on ...`
    hint.fixNote = 'Check the WHERE clause: a condition on the nullable side that is not IS NULL already turns the outer join into an inner one in effect.'
  } else if (lf.hasOr) {
    why = 'The condition is an OR, so the planner cannot split it into per-table filters.'
  } else {
    why = 'The planner normally pushes single-table conditions down to the scan. It could not here, usually because the expression involves a non-immutable function, a subquery, or an outer join boundary.'
  }
  hint.detail = `${lf.key} ${lf.text} runs on the ${n.type} instead of on the scan of ${tables}: ${lf.amount}.\n\n${why}`
  return hint
}

function orAcrossTables(n: PlanNode, lf: LateFilter): Hint {
  const refs = [...lf.refs]
  return { id: 'or-across-tables', severity: lf.rem >= 100000 ? 'high' : 'medium', category: 'rewrite', nodeId: n.id, title: 'OR across two tables forces a full join',
    detail: `${lf.key} ${lf.text} mixes columns of ${refs.join(' and ')} in one OR, so neither side can be restricted before the join: ${lf.amount}.\n\nSplit it into one query per branch and combine them, so each branch restricts its own table and can use its own index.`,
    fix: `-- select ... where <${refs[0]} condition>\n-- union all\n-- select ... where <${refs[1]} condition> and not (<${refs[0]} condition>)`,
    fixNote: 'UNION (without ALL) removes duplicates but costs a sort; the NOT clause on the second branch keeps UNION ALL correct.' }
}

function crossTableFilter(n: PlanNode, lf: LateFilter): Hint {
  return { id: 'cross-table-filter', severity: 'low', category: 'rowflow', nodeId: n.id, title: 'Cross-table condition discards most joined rows',
    detail: `${lf.key} ${lf.text} compares columns of different tables, so it can only run after the join: ${lf.amount}.\n\nIf one side can be restricted independently (a date window, a status), add that condition so fewer rows reach the join.` }
}

// ---- fan-out --------------------------------------------------------------

/** A join that multiplies rows which a later aggregate or DISTINCT collapses again. */
export function fanOut(ctx: Ctx, n: PlanNode) {
  if (!joinTypes.has(n.type)) return
  const inputs = n.children.filter(isInput)
  if (inputs.length !== 2) return
  const out = tot(ctx, n)
  const small = Math.min(...inputs.map(i => tot(ctx, i)))
  if (out < 1000 || out < small * 2) return
  const p = collapseAbove(ctx, n)
  if (!p) return
  const after = tot(ctx, p)
  if (after > out / 2) return
  if (anotherJoinBetween(ctx, n, p, out)) return
  const smallSide = inputs.find(i => tot(ctx, i) === small)!
  const smallScan = scanUnder(smallSide)
  const smallName = smallScan ? tableName(ctx, smallScan) : 'the smaller input'
  add(ctx, fanOutHint(ctx, n, { collapse: p, small, out, after, smallName }))
}

/** The collapsing ancestor and the three row counts the hint compares. */
interface FanOut { collapse: PlanNode; small: number; out: number; after: number; smallName: string }

/** The nearest ancestor that removes duplicates, DISTINCT or GROUP BY; null when a scan intervenes or none exists. */
function collapseAbove(ctx: Ctx, n: PlanNode): PlanNode | null {
  let p = ctx.parent.get(n.id)
  while (p && !(p.type === 'Unique' || (collapseTypes.has(p.type) && p.raw['Group Key']))) {
    if (scanTypes.has(p.type)) return null
    p = ctx.parent.get(p.id)
  }
  return p ?? null
}

/** One hint per collapse: the join right below it sees the whole multiplication. */
function anotherJoinBetween(ctx: Ctx, n: PlanNode, p: PlanNode, out: number): boolean {
  for (let q = ctx.parent.get(n.id); q && q !== p; q = ctx.parent.get(q.id)) if (joinTypes.has(q.type) && tot(ctx, q) >= out) return true
  return false
}

function fanOutHint(ctx: Ctx, n: PlanNode, fo: FanOut): Hint {
  const { collapse: p, small, out, after, smallName } = fo
  const groupKey = p.raw['Group Key']
  const isDistinct = !!ctx.facts?.distinct || p.type === 'Unique'
  const keyText = groupKey ? ` on ${Array.isArray(groupKey) ? groupKey.join(', ') : groupKey}` : ''
  return { id: 'fan-out', severity: out >= 100000 ? 'high' : 'medium', category: 'rowflow', nodeId: n.id, title: `Join multiplies rows ${(out / Math.max(1, small)).toFixed(1)}x, then ${isDistinct ? 'DISTINCT' : p.type} collapses them`,
    detail: `${n.type} turns ${fmtNum(small)} rows of ${smallName} into ${fmtNum(out)} joined rows; the ${p.type}${keyText} above reduces them to ${fmtNum(after)}. Every multiplied row was built, carried and then thrown away.\n\n${isDistinct ? 'When DISTINCT exists only to undo join duplication, the join is really an existence test.' : 'Aggregate the many-side before joining, or join only what the aggregate needs.'}`,
    fix: isDistinct ? `-- replace the join with an existence test:\nselect ... from ${smallName} x\nwhere exists (select 1 from <joined tables> where <join condition to x> and <their conditions>)` : `-- aggregate the many side first:\nselect ... from ${smallName} x\njoin (select <key>, count(*), ... from <many side> group by <key>) m on m.<key> = x.<key>`,
    fixNote: 'Compare with EXPLAIN ANALYZE: the semi-join stops at the first match per row instead of producing every combination.' }
}

// ---- cross join -----------------------------------------------------------

export function crossJoin(ctx: Ctx, n: PlanNode) {
  if (n.type !== 'Nested Loop' || n.raw['Join Filter']) return
  const inputs = n.children.filter(isInput)
  if (inputs.length !== 2) return
  const [outer, inner] = inputs
  const outerAliases = aliasesUnder(outer)
  // A parameterised inner side references the outer row somewhere in its conditions.
  const conds = descendantConds(inner, allCondKeys).join(' AND ')
  for (const a of aliasRefs(conds)) if (outerAliases.has(a)) return
  const o = tot(ctx, outer)
  const perLoop = ctx.plan.analyze ? (inner.actualRows ?? 0) : inner.planRows
  const out = tot(ctx, n)
  if (o <= 1 || perLoop <= 1 || out < o * perLoop * 0.98) return
  const names = [outer, inner].map(s => { const sc = scanUnder(s); return sc ? tableName(ctx, sc) : s.type })
  add(ctx, { id: 'cross-join', severity: out >= 10000 ? 'high' : 'low', category: 'rewrite', nodeId: n.id, title: `Cross join between ${names[0]} and ${names[1]}`,
    detail: `No condition links the two inputs, so every row of one is paired with every row of the other: ${fmtNum(o)} x ${fmtNum(perLoop)} = ${fmtNum(out)} rows.\n\n${out >= 10000 ? 'Unless a cartesian product is intended, a join condition is missing (often a table listed in FROM that the WHERE clause never ties to the others).' : 'Small enough to be harmless if intended.'}` })
}
