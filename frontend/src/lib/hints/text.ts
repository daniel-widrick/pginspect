// Column predicates read out of a plan's expression text, for when the parse
// tree is unavailable or the planner rewrote the predicate.
import type { ColRef } from '../sqlast'
import { quoteIdent } from '../sqlast'
import { stripStrings } from './ctx'

const exprKeywords = new Set(['and', 'or', 'not', 'is', 'null', 'true', 'false', 'any', 'all', 'some', 'in', 'like', 'ilike', 'between', 'similar', 'to', 'escape', 'case', 'when', 'then', 'else', 'end', 'subplan', 'initplan', 'hashed', 'distinct', 'from', 'array', 'row', 'interval', 'date', 'time', 'timestamp', 'zone', 'with', 'without', 'collate', 'at', 'current_date', 'current_timestamp', 'now', 'symmetric', 'asymmetric', 'unknown', 'nulls', 'first', 'last', 'asc', 'desc'])

export interface TextPredicate { col: ColRef; op: string; wrapped: 'func' | 'cast' | null; exprSql: string | null; foreign: boolean; leadingWildcard: boolean }

/**
 * Column predicates from a plan expression such as
 * ((status = 'paid'::text) AND (total > '900'::numeric)). A fallback for
 * when the parse tree is unavailable or the planner rewrote the predicate.
 */
export function textPredicates(text: string, own: string | null): TextPredicate[] {
  const out: TextPredicate[] = []
  const s = stripStrings(text)
  const re = /(?<![\w."])(?:("[^"]+"|[A-Za-z_][\w$]*)\.)?("[^"]+"|[A-Za-z_][\w$]*)(?![\w$"(])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const qual = m[1]?.replace(/^"|"$/g, '') ?? null
    const name = m[2].replace(/^"|"$/g, '')
    const before = s.slice(0, m.index)
    if (!isColumnToken(before, qual, name)) continue
    const w = unwrapColumn(s, before, s.slice(m.index + m[0].length), qual, name)
    const op = operatorAround(w.after, before)
    if (!op) continue
    const foreign = qual !== null && own !== null && qual !== own
    out.push({ col: { alias: qual, column: name }, op: comparesForeignColumn(w.after, own) ? 'JOIN' : op, wrapped: w.wrapped, exprSql: w.exprSql, foreign, leadingWildcard: false })
  }
  markLeadingWildcards(text, out)
  return out
}

/** An identifier match that is really a column, not a type name, keyword or parameter. */
function isColumnToken(before: string, qual: string | null, name: string): boolean {
  if (/::\s*(?:[A-Za-z_][\w ]*)?$/.test(before)) return false
  if (/\.$/.test(before)) return false
  if (!qual && exprKeywords.has(name.toLowerCase())) return false
  return !/^\$\d+$/.test(name)
}

interface Unwrapped { wrapped: TextPredicate['wrapped']; exprSql: string | null; after: string }

/**
 * Peels a cast or a function call off the column to reach the operator, and
 * keeps the wrapped expression's text for an expression index. Casts that only
 * change the string type do not count.
 */
function unwrapColumn(s: string, before: string, after: string, qual: string | null, name: string): Unwrapped {
  const castM = /^\)\s*::\s*([A-Za-z_][\w ]*?)(\[\])?(?=[\s)=<>~!]|$)/.exec(after)
  if (castM && !['text', 'character varying', 'bpchar', 'character', 'varchar'].includes(castM[1].trim())) {
    return { wrapped: 'cast', exprSql: `(${qual ? qual + '.' : ''}${quoteIdent(name)})::${castM[1].trim()}${castM[2] ?? ''}`, after }
  }
  const funcM = /([A-Za-z_][\w.]*)\s*\(\s*\(?\s*$/.exec(before)
  if (funcM && !['any', 'all', 'some', 'coalesce', 'not', 'and', 'or', 'array'].includes(funcM[1].toLowerCase())) {
    const end = closingParen(s, funcM.index)
    if (end > 0) {
      const exprSql = s.slice(funcM.index, end).replace(/\(\((\w+)\)::text\)/g, '($1)').replace(/\((\w+)\)::text/g, '$1')
      return { wrapped: 'func', exprSql, after: s.slice(end) }
    }
  }
  return { wrapped: null, exprSql: null, after }
}

/** Index just past the parenthesis that closes the call opening at start, or -1. */
function closingParen(s: string, start: number): number {
  let depth = 0
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') { depth--; if (depth === 0) return i + 1 }
  }
  return -1
}

/**
 * The operator applied to the column: usually to its right, after any closing
 * parens and casts, otherwise to its left when the column is the right-hand
 * side, as the p.id in (product_id = p.id).
 */
function operatorAround(after: string, before: string): string | null {
  const rest = after.replace(/^[\s)]*(?:::[\w ]+(?:\[\])?)?[\s)]*/, '')
  let opM = /^(IS NOT NULL|IS NULL|= ANY|<> ALL|<>|!=|<=|>=|=|<|>|!~~\*|!~~|~~\*|~~|~\*|~|IS NOT DISTINCT FROM|IS DISTINCT FROM|@>|<@|&&|@@)/i.exec(rest)
  if (!opM) opM = /(<>|!=|<=|>=|=|<|>)\s*$/.exec(before.replace(/\(+$/, ''))
  if (!opM) return null
  const op = opM[1].toUpperCase()
  return op === '= ANY' ? 'IN' : op
}

/** Whether the right-hand side is another relation's column, which makes the predicate a join key. */
function comparesForeignColumn(after: string, own: string | null): boolean {
  const rest = after.replace(/^[\s)]*(?:::[\w ]+(?:\[\])?)?[\s)]*/, '')
  const rhs = /^\s*(?:=|<>|<=|>=|<|>)\s*("[^"]+"|[A-Za-z_][\w$]*)\.("[^"]+"|[A-Za-z_][\w$]*)/.exec(rest)
  if (!rhs) return false
  const rq = rhs[1].replace(/^"|"$/g, '')
  return !!own && rq !== own
}

/** Leading wildcards need the original strings, which the scan stripped. */
function markLeadingWildcards(text: string, preds: TextPredicate[]): void {
  for (const p of preds) {
    if (p.op !== '~~' && p.op !== '~~*') continue
    const idx = text.indexOf(p.col.column)
    const lit = /~~\*?\s*'([^']*)'/.exec(text.slice(idx))
    p.leadingWildcard = lit ? /^[%_]/.test(lit[1]) : true
  }
}

