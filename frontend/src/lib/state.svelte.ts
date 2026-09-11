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
  running: boolean
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

export type Tab = QueryTab | StructureTab

export type Dialog =
  | { kind: 'profile'; profile: config.Profile | null }
  | { kind: 'password'; profileId: string; error: string; busy: boolean }
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
  sidebarWidth: 280,
  editorHeight: 260,
  toast: '' as string,
  schemas: {} as Record<string, SchemaMap>,
  /** Lets the query runner ask the visible editor for the selected text. */
  editorApi: null as null | { getRunnableSql(): string },
})

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(message: string, ms = 3500) {
  store.toast = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { store.toast = '' }, ms)
}

export function activeTab(): Tab | undefined {
  return store.tabs.find(t => t.id === store.activeTabId)
}

export function profileName(id: string): string {
  return store.profiles.find(p => p.id === id)?.name ?? id
}

export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e) return String((e as any).message)
  return String(e)
}
