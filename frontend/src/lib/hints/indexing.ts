// Turning predicates into index advice: which columns, in what order, with
// which operator class, and the rewrites for expressions no index can serve.
import type { PlanNode } from '../plan'
import { quoteIdent } from '../sqlast'
import { alias, stripStrings, type Ctx } from './ctx'
import { textPredicates } from './text'

export interface IndexCol { sql: string; kind: 'eq' | 'range' | 'like' | 'null' | 'other'; expression: boolean; note?: string }

export interface IndexPred { col: string; op: string; exprSql: string | null; wrapped: 'func' | 'cast' | null; leadingWildcard: boolean }

export interface ScanPred extends IndexPred { source: 'sql' | 'plan' }

/** Turns predicates on one relation into an ordered index column list. */
export function indexColumns(preds: IndexPred[]): { cols: IndexCol[]; trgm: string[]; notes: string[] } {
  const cols: IndexCol[] = []
  const trgm: string[] = []
  const notes: string[] = []
  const seen = new Set<string>()
  for (const p of preds) {
    const op = p.op.toUpperCase()
    const kind = indexKind(op)
    if (!kind) continue
    const sql = p.wrapped && p.exprSql ? `(${p.exprSql})` : quoteIdent(p.col)
    if (seen.has(sql)) continue
    seen.add(sql)
    if (kind !== 'like') cols.push({ sql, kind, expression: !!p.wrapped })
    else if (p.leadingWildcard || needsTrigram(op)) trgm.push(sql)
    else cols.push({ sql: `${sql} text_pattern_ops`, kind, expression: !!p.wrapped, note: 'text_pattern_ops lets a btree serve LIKE with a fixed prefix' })
  }
  const rank = { eq: 0, null: 1, range: 2, like: 3, other: 4 }
  cols.sort((a, b) => rank[a.kind] - rank[b.kind])
  if (cols.filter(c => c.kind === 'range').length > 1) notes.push('Only the first range column can bound the index scan; the others are filtered inside it.')
  return { cols, trgm, notes }
}

/** The index column kind an operator calls for, or null when no btree can help. */
function indexKind(op: string): IndexCol['kind'] | null {
  if (['=', 'EQ', 'IN', 'JOIN'].includes(op)) return 'eq'
  if (['<', '>', '<=', '>=', 'RANGE'].includes(op)) return 'range'
  if (['~~', 'LIKE'].includes(op) || needsTrigram(op)) return 'like'
  if (op === 'IS NULL' || op === 'NULL') return 'null'
  return null
}

/** Case-insensitive and regular-expression matches cannot use a btree at all. */
function needsTrigram(op: string): boolean {
  return ['~~*', 'ILIKE', '~', '~*', 'REGEX'].includes(op)
}

/** Predicates on a scan node's relation, from the parse tree when possible, else from the plan text. */
export function scanPredicates(ctx: Ctx, n: PlanNode, keys: string[] = ['Filter']): ScanPred[] {
  const own = alias(n)
  const out: ScanPred[] = []
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

/** Index predicates from a plan expression, keeping only the scanned relation's own columns. */
export function textIndexPreds(text: string, own: string | null): IndexPred[] {
  return textPredicates(text, own).filter(p => !p.foreign).map(p => ({ col: p.col.column, op: p.op, exprSql: p.exprSql, wrapped: p.wrapped, leadingWildcard: p.leadingWildcard }))
}

export function eqCol(column: string): IndexCol {
  return { sql: quoteIdent(column), kind: 'eq', expression: false }
}

export function createIndex(table: string, cols: IndexCol[]): string {
  return `create index concurrently on ${table} (${cols.map(c => c.sql).join(', ')});`
}

/** Casting a timestamp to a date depends on the session time zone, so it cannot be indexed. */
export function dateCastRewrite(p: { col: string; exprSql: string | null; wrapped: 'func' | 'cast' | null }): string | null {
  if (!p.exprSql) return null
  const e = p.exprSql.toLowerCase()
  if (p.wrapped === 'cast' && /::date$/.test(e)) return `${quoteIdent(p.col)} >= '<day>' and ${quoteIdent(p.col)} < '<day>'::date + 1`
  if (p.wrapped === 'func' && /^date_trunc\(/.test(e)) return `${quoteIdent(p.col)} >= '<start>' and ${quoteIdent(p.col)} < '<end>'`
  if (p.wrapped === 'func' && /^(date|extract|date_part)\(/.test(e)) return `${quoteIdent(p.col)} >= '<start>' and ${quoteIdent(p.col)} < '<end>'`
  return null
}
