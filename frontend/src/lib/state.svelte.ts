// Application state shared across components. Svelte 5 runes make this a
// reactive singleton: components read fields directly and mutate them in place.
import type { config, db } from '../../wailsjs/go/models'

export interface QueryTab {
  kind: 'query'
  id: string
  title: string
  connId: string
  sql: string
  response: db.QueryResponse | null
  plan: db.ExplainResponse | null
  /** Which pane the results area shows. */
  view: 'results' | 'plan'
  running: boolean
  /** Wall-clock start of the current run, for the elapsed display. */
  startedAt: number
  queryId: string
  activeResult: number
}

export interface StructureTab {
  kind: 'structure'
  id: string
  title: string
  connId: string
  schema: string
  name: string
  info: db.RelationInfo | null
  error: string
  loading: boolean
}

export interface StatsTab {
  kind: 'stats'
  id: string
  title: string
  connId: string
  data: db.StatsResponse | null
  error: string
  loading: boolean
  currentDBOnly: boolean
  // View state lives on the tab so it survives switching tabs.
  filter: string
  sortKey: string
  sortDesc: boolean
  includeNested: boolean
  expanded: string | null
  sampling: db.SamplingStatus | null
  samplingError: string
}

export interface SlowLogTab {
  kind: 'slowlog'
  id: string
  title: string
  connId: string
  data: db.SlowLogResult | null
  error: string
  loading: boolean
  filter: string
  minMs: number
  maxBytes: number
  expanded: number | null
  sortKey: string
  sortDesc: boolean
}

export type Tab = QueryTab | StructureTab | StatsTab | SlowLogTab

export type Dialog =
  | { kind: 'profile'; profile: config.Profile | null }
  | { kind: 'password'; profileId: string; error: string; busy: boolean }
  | { kind: 'params'; connId: string; sql: string; params: number[]; title: string }
  | null

/** Table columns known per connection, used for editor autocompletion. */
export type SchemaMap = Record<string, Record<string, string[]>>

export const store = $state({
  profiles: [] as config.Profile[],
  connected: {} as Record<string, db.Info>,
  connecting: {} as Record<string, boolean>,
  tabs: [] as Tab[],
  activeTabId: '',
  dialog: null as Dialog,
  maxRows: 1000,
  /** statement_timeout applied to each run, in ms; 0 means none. */
  timeoutMs: 0,
  sidebarWidth: 280,
  editorHeight: 260,
  toast: '' as string,
  schemas: {} as Record<string, SchemaMap>,
  /** Lets the query runner ask the visible editor for the selected text. */
  editorApi: null as null | { getRunnableSql(): string },
})

// Remember the few settings worth keeping between launches.
try {
  const saved = JSON.parse(localStorage.getItem('pginspect.settings') ?? '{}')
  if (typeof saved.maxRows === 'number') store.maxRows = saved.maxRows
  if (typeof saved.timeoutMs === 'number') store.timeoutMs = saved.timeoutMs
} catch { /* fresh start */ }
export function saveSettings() {
  try { localStorage.setItem('pginspect.settings', JSON.stringify({ maxRows: store.maxRows, timeoutMs: store.timeoutMs })) } catch { /* ignore */ }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(message: string, ms = 3500) {
  store.toast = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { store.toast = '' }, ms)
}

export function activeTab(): Tab | undefined {
  return store.tabs.find(t => t.id === store.activeTabId)
}

/** Major server version for a connection, or 0 when unknown. */
export function serverMajor(connId: string): number {
  const v = store.connected[connId]?.serverVersion ?? ''
  return parseInt(v, 10) || 0
}

export function profileName(id: string): string {
  return store.profiles.find(p => p.id === id)?.name ?? id
}

export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e) return String((e as any).message)
  return String(e)
}
