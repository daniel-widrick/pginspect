// Rules about a single scan: a sequential scan whose filter wants an index,
// an index scan that then filters most rows away, and a scan repeated once
// per outer row.
import type { PlanNode } from '../plan'
import { pct } from '../plan'
import { quoteIdent } from '../sqlast'
import { add, alias, aliasRefs, fmtNum, num, rowsIn, share, tableName, tot, type Ctx } from './ctx'
import { createIndex, dateCastRewrite, eqCol, indexColumns, scanPredicates, textIndexPreds, type IndexCol, type ScanPred } from './indexing'
import { textPredicates } from './text'
import type { Severity } from './types'

export function seqScanFilter(ctx: Ctx, n: PlanNode) {
  if (n.type !== 'Seq Scan' || !n.raw['Filter']) return
  const text = String(n.raw['Filter'])
  if (/SubPlan|InitPlan/.test(text)) return
  if ([...aliasRefs(text)].some(a => a !== alias(n))) return
  const scanned = rowsIn(ctx, n), kept = tot(ctx, n)
  const analyze = ctx.plan.analyze
  const significant = analyze ? scanned >= 10000 && kept <= scanned * 0.2 : share(ctx, n) >= 0.2
  if (!significant) return
  const table = tableName(ctx, n)
  const sc: SeqScan = {
    table, preds: scanPredicates(ctx, n), text,
    where: seqScanSummary(ctx, n, table, scanned, kept),
    severity: analyze && scanned >= 100000 && kept <= scanned * 0.05 ? 'high' : 'medium',
  }
  if (rewriteHint(ctx, n, sc)) return
  seqScanIndexHints(ctx, n, sc)
}

/** What the sequential-scan hints have in common: the table, its predicates, the summary sentence and how bad it is. */
interface SeqScan { table: string; preds: ScanPred[]; text: string; where: string; severity: Severity }

function seqScanSummary(ctx: Ctx, n: PlanNode, table: string, scanned: number, kept: number): string {
  if (!ctx.plan.analyze) return `The sequential scan on ${table} carries ${pct(share(ctx, n))} of the estimated cost and its filter keeps an estimated ${fmtNum(kept)} rows.`
  const loops = n.loops > 1 ? ` over ${fmtNum(n.loops)} loops` : ''
  return `The sequential scan on ${table} read ${fmtNum(scanned)} rows${loops} and kept ${fmtNum(kept)} (${pct(kept / Math.max(1, scanned))}).`
}

/** Expressions that no index can serve because they are not immutable. Reports the first and says whether it did. */
function rewriteHint(ctx: Ctx, n: PlanNode, sc: SeqScan): boolean {
  for (const p of sc.preds) {
    const rewrite = dateCastRewrite(p)
    if (!rewrite) continue
    add(ctx, { id: 'expr-rewrite', severity: sc.severity, category: 'rewrite', nodeId: n.id, title: `Filter on ${p.exprSql} cannot use an index`,
      detail: `${sc.where}\n\nThe predicate wraps ${quoteIdent(p.col)} in ${p.exprSql}, which is not immutable for timestamps (it depends on the session time zone), so no index can be built on it. Compare the raw column against a range instead.`,
      fix: `where ${rewrite}`, fixNote: 'A plain btree index on the column then serves the range.' })
    return true
  }
  return false
}

function seqScanIndexHints(ctx: Ctx, n: PlanNode, sc: SeqScan) {
  const { table, where, severity, text } = sc
  const { cols, trgm, notes } = indexColumns(sc.preds)
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

export function indexThenFilter(ctx: Ctx, n: PlanNode) {
  const counts = filterHeavyIndexScan(ctx, n)
  if (!counts) return
  const { rem, kept } = counts
  const table = tableName(ctx, n)
  const condNode = n.type === 'Bitmap Heap Scan' ? n.children.find(c => c.type === 'Bitmap Index Scan') ?? n : n
  const indexName = condNode.raw['Index Name'] ?? '?'
  const filterPreds = scanPredicates(ctx, n)
  const keys = indexColumns(textIndexPreds(String(condNode.raw['Index Cond'] ?? ''), alias(n)))
  const filterCols = indexColumns(filterPreds).cols.filter(c => !keys.cols.some(k => k.sql === c.sql))
  const loops = n.loops > 1 ? ` over ${fmtNum(n.loops)} loops` : ''
  const detail = `Index ${indexName} found ${fmtNum(rem + kept)} rows${loops}, then the filter ${n.raw['Filter']} threw away ${fmtNum(rem)} of them (${pct(rem / Math.max(1, rem + kept))}). Every discarded row was still fetched from the table.`
  if (!filterCols.length || !keys.cols.length) {
    add(ctx, { id: 'index-filter', severity: 'medium', category: 'index', nodeId: n.id, title: `Index ${indexName} on ${table} then filters most rows away`, detail })
    return
  }
  add(ctx, { id: 'extend-index', severity: rem >= 100000 ? 'high' : 'medium', category: 'index', nodeId: n.id, title: `Index ${indexName} needs the filter column too`,
    detail: `${detail}\n\nAdding the filtered column to the index lets the index scan skip those rows. Equality columns go first, then the range or sort column.`,
    fix: createIndex(table, extendedIndex(keys.cols, filterCols)),
    fixNote: `If ${indexName} is only used for this pattern the new index replaces it; otherwise keep both. A partial index (... where ${filterPreds.map(p => quoteIdent(p.col)).join(', ')} ...) is an alternative when the filter value is fixed.` })
}

/**
 * A measured index scan whose filter discarded at least as many rows as it
 * kept, and enough of them to matter. Returns the removed and kept counts,
 * or null when the rule does not apply.
 */
function filterHeavyIndexScan(ctx: Ctx, n: PlanNode): { rem: number; kept: number } | null {
  if (!['Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'].includes(n.type) || !n.raw['Filter']) return null
  if (!ctx.plan.analyze || /SubPlan|InitPlan/.test(String(n.raw['Filter']))) return null
  const rem = num(n.raw['Rows Removed by Filter']) * n.loops
  const kept = tot(ctx, n)
  if (rem < 1000 || kept > rem) return null
  // A lookup that fetches a couple of rows per loop has nothing to gain.
  if ((rem + kept) / n.loops < 10) return null
  return { rem, kept }
}

/** Equality columns from both lists first, then the rest, keys before filter columns within each group. */
function extendedIndex(keys: IndexCol[], filter: IndexCol[]): IndexCol[] {
  const eq = (c: IndexCol) => c.kind === 'eq'
  return [...keys.filter(eq), ...filter.filter(eq), ...keys.filter(c => !eq(c)), ...filter.filter(c => !eq(c))]
}

/** A scan that runs once per outer row with a filter tied to that outer row. */
export function repeatedScan(ctx: Ctx, n: PlanNode) {
  if (n.type !== 'Seq Scan' || n.loops < 10 || !ctx.plan.analyze) return
  const own = alias(n)
  const text = String(n.raw['Filter'] ?? '')
  const refs = [...aliasRefs(text)].filter(a => a !== own)
  if (!refs.length) return
  const scanned = rowsIn(ctx, n)
  if (scanned < 100000) return
  const table = tableName(ctx, n)
  const local = textPredicates(text, own).filter(p => !p.foreign && (p.op === 'JOIN' || p.op === '='))
  const cols = local.map(p => eqCol(p.col.column))
  add(ctx, { id: 'repeated-scan', severity: 'high', category: 'index', nodeId: n.id, title: `${table} is scanned in full ${fmtNum(n.loops)} times`,
    detail: `This sequential scan runs once per row of ${refs.join(', ')}: ${fmtNum(n.loops)} loops reading ${fmtNum(scanned)} rows in total to keep ${fmtNum(tot(ctx, n))}. The filter ${text} ties each pass to the outer row, which is exactly what an index lookup does cheaply.`,
    fix: cols.length ? createIndex(table, cols) : undefined,
    fixNote: cols.length ? 'With the index each loop becomes an index scan on the join key.' : undefined })
}
