// The public shape of an analysis: hints, the row-flow pipeline and the
// options a caller can pass. Rules live in the sibling modules.
import type { PlanNode } from '../plan'
import type { SqlFacts } from '../sqlast'

export type Severity = 'high' | 'medium' | 'low'
export type Category = 'index' | 'statistics' | 'memory' | 'rewrite' | 'rowflow' | 'config' | 'maintenance'

export interface Hint {
  id: string
  severity: Severity
  category: Category
  title: string
  /** Plain text; paragraphs separated by blank lines. */
  detail: string
  /** Plan node the hint is about, for highlighting. */
  nodeId: number | null
  /** SQL the user can copy to apply or test the suggestion. */
  fix?: string
  fixNote?: string
}

export interface FlowStep {
  node: PlanNode
  rowsIn: number
  rowsOut: number
  /** Fraction of input rows that survived. */
  kept: number
  /** A filter evaluated on a join or above it, after the rows were already joined. */
  late: boolean
}

export interface Analysis {
  hints: Hint[]
  /** Pipeline nodes in execution order, with row counts in and out. */
  flow: FlowStep[]
  /** Base relations in the query, from the parse tree when available. */
  relations: number
}

export interface AnalyzeOptions {
  facts?: SqlFacts | null
  serverMajor?: number
  /** Schema of a table the query text does not name (a table behind a view), when unambiguous. */
  schemaOf?: (table: string) => string | null | undefined
}
