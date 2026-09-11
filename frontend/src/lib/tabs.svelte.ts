// Tab lifecycle and query execution.
import { RunQuery, CancelQuery, RelationInfo } from '../../wailsjs/go/main/App'
import { store, activeTab, errorMessage, toast, type QueryTab, type StructureTab, type Tab } from './state.svelte'

let counter = 0
const nextId = () => `${Date.now().toString(36)}-${++counter}`

export function newQueryTab(connId: string, sql = '', title = ''): QueryTab {
  const tab: QueryTab = {
    kind: 'query',
    id: nextId(),
    title: title || `Query ${store.tabs.filter(t => t.kind === 'query').length + 1}`,
    connId,
    sql,
    response: null,
    running: false,
    queryId: '',
    activeResult: 0,
  }
  store.tabs.push(tab)
  store.activeTabId = tab.id
  // Return the reactive proxy, not the plain object: mutations through the
  // original reference would bypass Svelte's change tracking.
  return store.tabs[store.tabs.length - 1] as QueryTab
}

export async function openStructureTab(connId: string, schema: string, name: string): Promise<void> {
  const existing = store.tabs.find(
    t => t.kind === 'structure' && t.connId === connId && t.schema === schema && t.name === name,
  )
  if (existing) {
    store.activeTabId = existing.id
    return
  }
  const tab: StructureTab = {
    kind: 'structure',
    id: nextId(),
    title: `${schema}.${name}`,
    connId,
    schema,
    name,
    info: null,
    error: '',
    loading: true,
  }
  store.tabs.push(tab)
  store.activeTabId = tab.id
  const live = store.tabs[store.tabs.length - 1] as StructureTab
  try {
    live.info = await RelationInfo(connId, schema, name)
  } catch (e) {
    live.error = errorMessage(e)
  } finally {
    live.loading = false
  }
}

export function closeTab(id: string): void {
  const idx = store.tabs.findIndex(t => t.id === id)
  if (idx < 0) return
  const tab = store.tabs[idx]
  if (tab.kind === 'query' && tab.running) cancelQuery(tab)
  store.tabs.splice(idx, 1)
  if (store.activeTabId === id) {
    const next = store.tabs[Math.min(idx, store.tabs.length - 1)]
    store.activeTabId = next?.id ?? ''
  }
}

export function closeTabsForConnection(connId: string): void {
  for (const t of [...store.tabs]) if (t.connId === connId) closeTab(t.id)
}

/** Runs the editor's selection (or whole document) in the active query tab. */
export async function runActive(): Promise<void> {
  const tab = activeTab()
  if (!tab || tab.kind !== 'query') return
  const sql = store.editorApi?.getRunnableSql() ?? tab.sql
  await runQuery(tab, sql)
}

export async function runQuery(tab: QueryTab, sql: string): Promise<void> {
  if (tab.running) return
  if (!sql.trim()) return
  if (!store.connected[tab.connId]) {
    toast('Not connected')
    return
  }
  tab.running = true
  tab.queryId = nextId()
  try {
    const resp = await RunQuery(tab.connId, tab.queryId, sql, store.maxRows)
    resp.results ??= []
    tab.response = resp
    tab.activeResult = Math.max(0, resp.results.length - 1)
    // Show the last result set that has columns, if any.
    for (let i = resp.results.length - 1; i >= 0; i--) {
      if (resp.results[i].columns?.length) { tab.activeResult = i; break }
    }
  } catch (e) {
    tab.response = { results: [], error: errorMessage(e), durationMs: 0, cancelled: false } as any
  } finally {
    tab.running = false
  }
}

export async function cancelQuery(tab: QueryTab): Promise<void> {
  if (!tab.running) return
  await CancelQuery(tab.connId, tab.queryId)
}

export function cancelActive(): void {
  const tab = activeTab()
  if (tab?.kind === 'query') void cancelQuery(tab)
}

export function isQueryTab(t: Tab | undefined): t is QueryTab {
  return t?.kind === 'query'
}
