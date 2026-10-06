// Rules about memory and maintenance: sorts and hashes that spill, lossy
// bitmaps, index-only scans that still visit the heap, and parallel workers
// that did not start.
import type { PlanNode } from '../plan'
import { quoteIdent } from '../sqlast'
import { add, alias, fmtNum, num, rowsIn, scanTypes, tableName, tot, type Ctx } from './ctx'
import { createIndex, indexColumns, scanPredicates, textIndexPreds, type IndexCol } from './indexing'
import type { Hint } from './types'

export function sortHints(ctx: Ctx, n: PlanNode) {
  if (n.type !== 'Sort' && n.type !== 'Incremental Sort') return
  const input = rowsIn(ctx, n)
  const child = n.children[0]
  const scan = child && scanTypes.has(child.type) ? child : null
  const own = scan ? alias(scan) : null
  const keys: string[] = Array.isArray(n.raw['Sort Key']) ? n.raw['Sort Key'].map(String) : []
  const keyCols = keys.map(k => sortKeyColumn(k, own))
  const indexable = !!scan && keyCols.every(Boolean) && keyCols.length > 0
  if (n.raw['Sort Space Type'] === 'Disk') {
    add(ctx, sortDiskHint(ctx, n, input, indexable ? scan : null, keyCols as IndexCol[]))
    return
  }
  const parent = ctx.parent.get(n.id)
  if (indexable && input >= 100000 && feedsLimit(ctx, parent)) add(ctx, topNIndexHint(ctx, n, scan!, parent!, input, keyCols as IndexCol[]))
}

/** A sort key that is a plain column of the scanned table, which an index can supply in order; null otherwise. */
function sortKeyColumn(key: string, own: string | null): IndexCol | null {
  const m = /^(?:("[^"]+"|[A-Za-z_][\w$]*)\.)?("[^"]+"|[A-Za-z_][\w$]*)(?:\s+(DESC|ASC))?(?:\s+NULLS\s+(FIRST|LAST))?$/i.exec(key.trim())
  if (!m) return null
  if (m[1] && own && m[1].replace(/"/g, '') !== own) return null
  const dir = m[3] ? ' ' + m[3].toLowerCase() : ''
  const nulls = m[4] ? ' nulls ' + m[4].toLowerCase() : ''
  return { sql: quoteIdent(m[2].replace(/"/g, '')) + dir + nulls, kind: 'other', expression: false }
}

/** The sort feeds a LIMIT, directly or through a Gather Merge. */
function feedsLimit(ctx: Ctx, parent: PlanNode | undefined): boolean {
  if (!parent) return false
  if (parent.type === 'Limit') return true
  return parent.type === 'Gather Merge' && ctx.parent.get(parent.id)?.type === 'Limit'
}

function sortDiskHint(ctx: Ctx, n: PlanNode, input: number, scan: PlanNode | null, keyCols: IndexCol[]): Hint {
  const used = num(n.raw['Sort Space Used'])
  const mb = Math.max(1, Math.ceil((used * 1.5) / 1024))
  let detail = `The sort used ${fmtNum(used)} kB of temporary files (${n.raw['Sort Method']}) because work_mem was too small to hold the rows. Disk sorts are several times slower than in-memory ones.`
  let fixNote = 'work_mem is per sort or hash operation, per backend; a query with several sorts can use multiples of it, so raise it for the role or session rather than globally.'
  if (scan) {
    const table = tableName(ctx, scan)
    detail += `\n\nAn index in sort order removes the sort entirely: the scan of ${table} returns rows already ordered.`
    const eqKeys = scan.raw['Index Cond'] ? indexColumns(textIndexPreds(String(scan.raw['Index Cond']), alias(scan))).cols.filter(c => c.kind === 'eq') : []
    fixNote += `\n\nAlternative: ${createIndex(table, [...eqKeys, ...keyCols])}`
  }
  return { id: 'sort-disk', severity: used >= 100000 ? 'high' : 'medium', category: 'memory', nodeId: n.id, title: `Sort of ${fmtNum(input)} rows spills to disk`,
    detail, fix: `set work_mem = '${mb}MB';  -- for this session, or per role: alter role ... set work_mem = '${mb}MB'`, fixNote }
}

function topNIndexHint(ctx: Ctx, n: PlanNode, scan: PlanNode, parent: PlanNode, input: number, keyCols: IndexCol[]): Hint {
  const table = tableName(ctx, scan)
  const eq = scanPredicates(ctx, scan, ['Filter', 'Index Cond', 'Recheck Cond']).filter(p => p.op === 'eq' || p.op === '=')
  const eqCols = indexColumns(eq).cols
  return { id: 'top-n-index', severity: input >= 1000000 ? 'high' : 'medium', category: 'index', nodeId: n.id, title: `Sorting ${fmtNum(input)} rows to return the first ${fmtNum(tot(ctx, parent))}`,
    detail: `LIMIT with ORDER BY still sorts every candidate row (${n.raw['Sort Method'] ?? 'sort'} over ${fmtNum(input)} rows) before taking the first few. With an index in the sort order the scan of ${table} reads rows in order and stops after the limit.`,
    fix: createIndex(table, [...eqCols, ...keyCols]),
    fixNote: eqCols.length ? 'Equality filter columns go first so the index range starts at the right place, then the sort columns.' : 'DESC and NULLS placement in the index must match the ORDER BY, or the planner reads it backwards only when that matches too.' }
}

export function hashBatches(ctx: Ctx, n: PlanNode) {
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

export function lossyBitmap(ctx: Ctx, n: PlanNode) {
  const lossy = num(n.raw['Lossy Heap Blocks'])
  if (n.type !== 'Bitmap Heap Scan' || lossy === 0) return
  const exact = num(n.raw['Exact Heap Blocks'])
  add(ctx, { id: 'lossy-bitmap', severity: lossy > exact ? 'medium' : 'low', category: 'memory', nodeId: n.id, title: `Bitmap scan went lossy on ${fmtNum(lossy)} blocks`,
    detail: `The bitmap exceeded work_mem, so ${fmtNum(lossy)} heap blocks (against ${fmtNum(exact)} exact) were recorded at page granularity and every row in them had to be rechecked against ${n.raw['Recheck Cond']}.`,
    fix: `set work_mem = '64MB';  -- for this session; the bitmap needs a few bytes per matching row` })
}

export function heapFetches(ctx: Ctx, n: PlanNode) {
  if (n.type !== 'Index Only Scan') return
  const fetches = num(n.raw['Heap Fetches'])
  const rows = tot(ctx, n)
  if (fetches < 1000 || fetches < rows * 0.5) return
  const table = tableName(ctx, n)
  add(ctx, { id: 'heap-fetches', severity: fetches >= rows ? 'medium' : 'low', category: 'maintenance', nodeId: n.id, title: `Index-only scan on ${table} still visits the table`,
    detail: `${fmtNum(fetches)} of ${fmtNum(rows)} rows needed a heap fetch to check visibility, because the visibility map does not mark their pages all-visible. That happens after inserts, updates or deletes until VACUUM runs.`,
    fix: `vacuum (analyze) ${table};`, fixNote: 'If it recurs, autovacuum is not keeping up with the write rate on this table: lower autovacuum_vacuum_scale_factor for it.' })
}

export function workersShort(ctx: Ctx, n: PlanNode) {
  if (n.raw['Workers Launched'] === undefined) return
  const launched = num(n.raw['Workers Launched']), planned = num(n.raw['Workers Planned'])
  if (launched >= planned) return
  add(ctx, { id: 'workers-short', severity: launched === 0 ? 'medium' : 'low', category: 'config', nodeId: n.id, title: `Only ${launched} of ${planned} parallel workers started`,
    detail: `The plan was costed for ${planned} workers but the server had ${launched} available when it ran, so the leader did more of the work than planned. Other parallel queries were using the pool, or max_parallel_workers / max_worker_processes is low.`,
    fix: `show max_parallel_workers;\nshow max_worker_processes;\nshow max_parallel_workers_per_gather;` })
}

