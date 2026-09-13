// Tab lifecycle and query execution.
import { RunQuery, CancelQuery, RelationInfo, Explain, StatStatements, StartActivitySampling, StopActivitySampling, ActivitySampling, SlowLog } from '../../wailsjs/go/main/App'
import { store, activeTab, errorMessage, toast, type QueryTab, type StructureTab, type StatsTab, type SlowLogTab, type Tab } from './state.svelte'

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
    plan: null,
    view: 'results',
    running: false,
    startedAt: 0,
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

/** Opens (or focuses) the pg_stat_statements browser for a connection. */
export async function openStatsTab(connId: string): Promise<void> {
  const existing = store.tabs.find(t => t.kind === 'stats' && t.connId === connId) as StatsTab | undefined
  if (existing) {
    store.activeTabId = existing.id
    return
  }
  const tab: StatsTab = {
    kind: 'stats', id: nextId(), title: 'Query statistics', connId,
    data: null, error: '', loading: false, currentDBOnly: true,
    filter: '', sortKey: 'totalMs', sortDesc: true, includeNested: false, expanded: null,
    sampling: null, samplingError: '',
  }
  store.tabs.push(tab)
  store.activeTabId = tab.id
  const live = store.tabs[store.tabs.length - 1] as StatsTab
  await Promise.all([refreshStats(live), setSampling(live, true)])
}

/** Opens (or focuses) the slow statement log for a connection. */
export async function openSlowLogTab(connId: string): Promise<void> {
  const existing = store.tabs.find(t => t.kind === 'slowlog' && t.connId === connId) as SlowLogTab | undefined
  if (existing) {
    store.activeTabId = existing.id
    return
  }
  const tab: SlowLogTab = {
    kind: 'slowlog', id: nextId(), title: 'Slow log', connId,
    data: null, error: '', loading: false, filter: '', minMs: 0, maxBytes: 8 * 1024 * 1024, expanded: null,
    sortKey: 'time', sortDesc: true,
  }
  store.tabs.push(tab)
  store.activeTabId = tab.id
  await refreshSlowLog(store.tabs[store.tabs.length - 1] as SlowLogTab)
}

export async function refreshSlowLog(tab: SlowLogTab): Promise<void> {
  if (tab.loading) return
  tab.loading = true
  tab.error = ''
  try {
    tab.data = await SlowLog(tab.connId, 500, tab.maxBytes)
  } catch (e) {
    tab.error = errorMessage(e)
  } finally {
    tab.loading = false
  }
}

/** Starts or stops capturing real statement texts from pg_stat_activity. */
export async function setSampling(tab: StatsTab, on: boolean): Promise<void> {
  tab.samplingError = ''
  try {
    if (on) await StartActivitySampling(tab.connId)
    else await StopActivitySampling(tab.connId)
  } catch (e) {
    tab.samplingError = errorMessage(e)
  }
  await refreshSampling(tab)
}

export async function refreshSampling(tab: StatsTab): Promise<void> {
  try {
    tab.sampling = await ActivitySampling(tab.connId)
  } catch {
    tab.sampling = null
  }
}

export async function refreshStats(tab: StatsTab): Promise<void> {
  if (tab.loading) return
  tab.loading = true
  tab.error = ''
  try {
    tab.data = await StatStatements(tab.connId, tab.currentDBOnly, 500)
  } catch (e) {
    tab.error = errorMessage(e)
  } finally {
    tab.loading = false
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
  tab.startedAt = Date.now()
  tab.queryId = nextId()
  tab.view = 'results'
  try {
    const resp = await RunQuery(tab.connId, tab.queryId, sql, store.maxRows, store.timeoutMs)
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

/** Explains the editor's selection (or whole document) in the active query tab. */
export async function explainActive(analyze: boolean): Promise<void> {
  const tab = activeTab()
  if (!tab || tab.kind !== 'query') return
  const sql = store.editorApi?.getRunnableSql() ?? tab.sql
  await explainQuery(tab, sql, analyze)
}

export async function explainQuery(tab: QueryTab, sql: string, analyze: boolean, generic = false): Promise<void> {
  if (tab.running) return
  if (!sql.trim()) return
  if (!store.connected[tab.connId]) {
    toast('Not connected')
    return
  }
  tab.running = true
  tab.startedAt = Date.now()
  tab.queryId = nextId()
  tab.view = 'plan'
  try {
    tab.plan = await Explain(tab.connId, tab.queryId, sql, analyze, generic, analyze ? store.timeoutMs : 0)
  } catch (e) {
    tab.plan = { plan: '', analyze, generic, error: errorMessage(e), durationMs: 0, cancelled: false } as any
  } finally {
    tab.running = false
  }
}

/** Numbered parameters ($1, $2, ...) present in a normalised statement. */
export function statementParams(sql: string): number[] {
  const seen = new Set<number>()
  for (const m of sql.matchAll(/\$(\d+)/g)) seen.add(Number(m[1]))
  return [...seen].sort((a, b) => a - b)
}

/** Replaces $n placeholders with the given SQL literals. */
export function substituteParams(sql: string, values: Record<number, string>): string {
  return sql.replace(/\$(\d+)/g, (m, n) => {
    const v = values[Number(n)]
    return v === undefined || v.trim() === '' ? m : `(${v.trim()})`
  })
}

/**
 * Explains a statement taken from pg_stat_statements. Parameterised
 * statements go through a dialog first; the rest open in a tab immediately.
 */
export function explainStatement(connId: string, sql: string, title: string): void {
  const params = statementParams(sql)
  if (params.length === 0) {
    const tab = newQueryTab(connId, sql.trim() + '\n', title)
    void explainQuery(tab, sql, false)
    return
  }
  store.dialog = { kind: 'params', connId, sql, params, title }
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
