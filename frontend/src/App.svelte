<script lang="ts">
  import { onMount } from 'svelte'
  import { EventsOn } from '../wailsjs/runtime/runtime'
  import { Version } from '../wailsjs/go/main/App'
  import { store, activeTab, profileName, saveSettings } from './lib/state.svelte'
  import { loadProfiles, blankProfile } from './lib/connections.svelte'
  import { newQueryTab, closeTab, runActive, runQuery, cancelActive, isQueryTab, explainActive, openStatsTab, openSlowLogTab } from './lib/tabs.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import Editor from './components/Editor.svelte'
  import ResultsGrid from './components/ResultsGrid.svelte'
  import PlanView from './components/PlanView.svelte'
  import StructureView from './components/StructureView.svelte'
  import StatsView from './components/StatsView.svelte'
  import SlowLogView from './components/SlowLogView.svelte'
  import ProfileDialog from './components/ProfileDialog.svelte'
  import PasswordDialog from './components/PasswordDialog.svelte'
  import ParamsDialog from './components/ParamsDialog.svelte'
  import Splitter from './components/Splitter.svelte'
  import UpdateBanner from './components/UpdateBanner.svelte'

  let editor = $state<Editor>()
  let grid = $state<ResultsGrid>()
  let mainEl = $state<HTMLElement>()
  let version = $state('')
  // Ticks while a query runs so the toolbar can show elapsed time.
  let now = $state(Date.now())
  $effect(() => {
    if (!queryTab?.running) return
    const t = setInterval(() => (now = Date.now()), 250)
    return () => clearInterval(t)
  })

  const tab = $derived(activeTab())
  const queryTab = $derived(isQueryTab(tab) ? tab : null)
  const info = $derived(tab ? store.connected[tab.connId] : undefined)

  $effect(() => {
    store.editorApi = editor ? { getRunnableSql: () => editor!.getRunnableSql() } : null
  })

  function newTab() {
    const connId = tab?.connId ?? Object.keys(store.connected)[0]
    if (!connId) { store.dialog = { kind: 'profile', profile: blankProfile() }; return }
    newQueryTab(connId)
  }

  function onKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 't') { e.preventDefault(); newTab() }
    else if (mod && e.key === 'w') { e.preventDefault(); if (tab) closeTab(tab.id) }
    else if (mod && e.key === 'Enter') { e.preventDefault(); void runActive() }
    else if (mod && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); void explainActive(e.shiftKey) }
    else if (mod && e.shiftKey && e.key === 'Escape') { cancelActive() }
  }

  onMount(() => {
    void loadProfiles()
    void Version().then(v => (version = v)).catch(() => {})
    const offs = [
      EventsOn('menu:newtab', newTab),
      EventsOn('menu:closetab', () => tab && closeTab(tab.id)),
      EventsOn('menu:newconnection', () => (store.dialog = { kind: 'profile', profile: blankProfile() })),
      EventsOn('menu:run', () => void runActive()),
      EventsOn('menu:cancel', cancelActive),
      EventsOn('menu:explain', () => void explainActive(false)),
      EventsOn('menu:explainanalyze', () => void explainActive(true)),
      EventsOn('menu:export', () => grid?.exportCsv()),
      EventsOn('menu:stats', () => { const c = tab?.connId ?? Object.keys(store.connected)[0]; if (c) void openStatsTab(c) }),
      EventsOn('menu:slowlog', () => { const c = tab?.connId ?? Object.keys(store.connected)[0]; if (c) void openSlowLogTab(c) }),
    ]
    return () => offs.forEach(off => off())
  })

  function fmtDuration(ms: number) {
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  <div class="side" style="width: {store.sidebarWidth}px">
    <Sidebar />
  </div>
  <Splitter direction="horizontal" onDrag={(d) => (store.sidebarWidth = Math.max(180, Math.min(600, store.sidebarWidth + d)))} />

  <main bind:this={mainEl}>
    <UpdateBanner />
    <div class="tabbar">
      {#each store.tabs as t (t.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
        <div class="tab" class:active={t.id === store.activeTabId} onclick={() => (store.activeTabId = t.id)} role="tab" tabindex="-1"
             onauxclick={(e) => { if (e.button === 1) closeTab(t.id) }}>
          <span class="tab-conn" style="background: {store.profiles.find(p => p.id === t.connId)?.color || 'var(--fg-3)'}" title={profileName(t.connId)}></span>
          <span class="tab-title">{t.kind === 'structure' ? '≡ ' : t.kind === 'stats' ? '∑ ' : t.kind === 'slowlog' ? '⏱ ' : ''}{t.title}</span>
          {#if t.kind === 'query' && t.running}<span class="tab-running"></span>{/if}
          <button class="tab-close" onclick={(e) => { e.stopPropagation(); closeTab(t.id) }} title="Close">×</button>
        </div>
      {/each}
      <button class="ghost small newtab" onclick={newTab} title="New query tab (Cmd/Ctrl+T)">+</button>
    </div>

    {#if queryTab}
      {#key queryTab.id}
        <div class="editor-pane" style="height: {store.editorHeight}px">
          <Editor bind:this={editor} bind:value={queryTab.sql} schema={store.schemas[queryTab.connId] ?? {}}
                  onRun={(sql) => runQuery(queryTab, sql)} />
        </div>
      {/key}
      <div class="toolbar">
        {#if queryTab.running}
          <button class="small danger cancel" onclick={cancelActive} title="Ask the server to stop this statement (Cmd/Ctrl+Shift+Esc)">■ Cancel · {((now - queryTab.startedAt) / 1000).toFixed(1)} s</button>
        {:else}
          <button class="primary small" onclick={() => runActive()} disabled={!info}>▶ Run</button>
        {/if}
        <span class="sep"></span>
        <button class="small" onclick={() => explainActive(false)} disabled={queryTab.running || !info} title="Estimated plan (Cmd/Ctrl+E)">Explain</button>
        <button class="small" onclick={() => explainActive(true)} disabled={queryTab.running || !info} title="Run and show the actual plan; writes are rolled back (Cmd/Ctrl+Shift+E)">Explain Analyze</button>
        <span class="sep"></span>
        <label class="limit">Limit
          <select bind:value={store.maxRows} onchange={saveSettings}>
            {#each [100, 500, 1000, 5000, 20000] as n}<option value={n}>{n}</option>{/each}
          </select>
        </label>
        <label class="limit" title="statement_timeout for each run; the server stops a statement that runs longer">Timeout
          <select bind:value={store.timeoutMs} onchange={saveSettings}>
            <option value={0}>none</option>
            {#each [[5000, '5 s'], [30000, '30 s'], [60000, '1 min'], [300000, '5 min'], [1800000, '30 min']] as [ms, label]}<option value={ms}>{label}</option>{/each}
          </select>
        </label>
        <span class="sep"></span>
        <button class="small" onclick={() => grid?.exportCsv()} disabled={!queryTab.response?.results.length}>Export CSV</button>
        <span class="grow"></span>
        {#if queryTab.response && queryTab.plan}
          <span class="segmented">
            <button class="small" class:active={queryTab.view === 'results'} onclick={() => (queryTab.view = 'results')}>Results</button>
            <button class="small" class:active={queryTab.view === 'plan'} onclick={() => (queryTab.view = 'plan')}>Plan</button>
          </span>
        {/if}
        <span class="hint muted"><kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> runs selection or all</span>
      </div>
      <Splitter direction="vertical" onDrag={(d) => (store.editorHeight = Math.max(80, Math.min((mainEl?.clientHeight ?? 800) - 160, store.editorHeight + d)))} />
      <div class="results-pane">
        {#if queryTab.view === 'plan'}
          <PlanView tab={queryTab} />
        {:else}
          <ResultsGrid bind:this={grid} tab={queryTab} />
        {/if}
      </div>
    {:else if tab?.kind === 'structure'}
      <div class="results-pane"><StructureView {tab} /></div>
    {:else if tab?.kind === 'stats'}
      <div class="results-pane"><StatsView {tab} /></div>
    {:else if tab?.kind === 'slowlog'}
      <div class="results-pane"><SlowLogView {tab} /></div>
    {:else}
      <div class="welcome">
        <h1>pginspect <span class="version">{version}</span></h1>
        <p class="muted">Connect to a database on the left, or add one to get started.</p>
        <p class="muted small">
          <kbd>⌘/Ctrl</kbd>+<kbd>T</kbd> new query tab &nbsp;
          <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> run &nbsp;
          double-click a table to see its data
        </p>
      </div>
    {/if}

    <footer class="status">
      {#if tab && info}
        <span class="dot" style="background: {store.profiles.find(p => p.id === tab.connId)?.color || 'var(--ok)'}"></span>
        <span>{profileName(tab.connId)}</span>
        <span class="muted">{info.user}@{info.database}</span>
        <span class="muted">PostgreSQL {info.serverVersion}</span>
      {:else if tab}
        <span class="muted">{profileName(tab.connId)} (disconnected)</span>
      {/if}
      <span class="grow"></span>
      {#if queryTab?.view === 'plan' && queryTab.plan}
        <span class="muted">{queryTab.plan.analyze ? 'explain analyze' : 'explain'} {fmtDuration(queryTab.plan.durationMs)}</span>
      {:else if tab?.kind === 'stats' && tab.data?.available}
        <span class="muted">{tab.data.statements.length} statements shown</span>
      {:else if tab?.kind === 'slowlog' && tab.data}
        <span class="muted">{tab.data.entries.length} logged executions{tab.data.complete ? '' : ' (more in older files)'}</span>
      {:else if queryTab?.response}
        {@const r = queryTab.response.results[queryTab.activeResult]}
        {#if r?.columns?.length}
          <span>{r.rows.length.toLocaleString()}{r.truncated && !queryTab.response.limitStopped ? ` of ${r.rowCount.toLocaleString()}` : ''} rows{queryTab.response.limitStopped ? ' · stopped at the limit, statement cancelled on the server' : r.truncated ? ' (truncated)' : ''}</span>
        {/if}
        {#if queryTab.response.timedOut}<span class="muted">statement timeout</span>{/if}
        <span class="muted">{fmtDuration(queryTab.response.durationMs)}</span>
      {/if}
    </footer>
  </main>

  {#if store.dialog?.kind === 'profile' && store.dialog.profile}
    <ProfileDialog profile={store.dialog.profile} />
  {:else if store.dialog?.kind === 'password'}
    <PasswordDialog profileId={store.dialog.profileId} />
  {:else if store.dialog?.kind === 'params'}
    <ParamsDialog request={store.dialog} />
  {/if}

  {#if store.toast}
    <div class="toast">{store.toast}</div>
  {/if}
</div>

<style>
  .app { display: flex; height: 100vh; width: 100vw; overflow: hidden; }
  .side { flex-shrink: 0; height: 100%; min-width: 180px; }
  main { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100%; }
  .tabbar { display: flex; align-items: flex-end; background: var(--bg-2); border-bottom: 1px solid var(--border); padding: 4px 6px 0; gap: 2px; overflow-x: auto; flex-shrink: 0; height: 34px; }
  .tab { display: flex; align-items: center; gap: 6px; padding: 5px 6px 5px 10px; border-radius: 6px 6px 0 0; color: var(--fg-2); max-width: 220px; cursor: default; user-select: none; flex-shrink: 0; }
  .tab:hover { background: var(--bg-hover); }
  .tab.active { background: var(--bg); color: var(--fg); box-shadow: inset 0 2px 0 var(--accent); }
  .tab-conn { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
  .tab-close { border: none; background: transparent; padding: 0 4px; color: var(--fg-3); font-size: 14px; line-height: 1; border-radius: 3px; }
  .tab-close:hover { background: var(--bg-3); color: var(--fg); }
  .tab-running { width: 8px; height: 8px; border: 2px solid var(--fg-3); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .newtab { margin-bottom: 3px; }
  .editor-pane { flex-shrink: 0; min-height: 80px; border-bottom: 1px solid var(--border); }
  .toolbar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--bg-2); border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .sep { width: 1px; height: 16px; background: var(--border); margin: 0 4px; }
  .limit { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-2); }
  .limit select { width: auto; padding: 2px 6px; font-size: 12px; }
  .cancel { background: color-mix(in srgb, var(--danger) 15%, var(--bg-3)); border-color: var(--danger); font-variant-numeric: tabular-nums; }
  .grow { flex: 1; }
  .segmented { display: inline-flex; }
  .segmented button { border-radius: 0; }
  .segmented button:first-child { border-radius: 5px 0 0 5px; }
  .segmented button:last-child { border-radius: 0 5px 5px 0; border-left: none; }
  .segmented button.active { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .hint { font-size: 11px; }
  .results-pane { flex: 1; min-height: 0; overflow: hidden; }
  .welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; }
  .welcome h1 { font-weight: 600; font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  .welcome .version { font-size: 12px; font-weight: 400; color: var(--fg-3); font-family: var(--font-mono); vertical-align: middle; }
  .welcome .small { font-size: 12px; }
  .status { display: flex; align-items: center; gap: 12px; padding: 3px 10px; border-top: 1px solid var(--border); background: var(--bg-2); font-size: 11.5px; flex-shrink: 0; height: 24px; }
  .status .dot { width: 7px; height: 7px; border-radius: 50%; }
  .toast { position: fixed; bottom: 36px; left: 50%; transform: translateX(-50%); background: var(--fg); color: var(--bg); padding: 8px 14px; border-radius: 8px; font-size: 12.5px; box-shadow: 0 6px 24px rgba(0,0,0,0.3); z-index: 100; max-width: 70vw; white-space: pre-wrap; }
</style>
