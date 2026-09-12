<script lang="ts">
  import { ClipboardSetText } from '../../wailsjs/runtime/runtime'
  import { ResetStatStatements, InstallStatStatements, QueryExamples } from '../../wailsjs/go/main/App'
  import type { db } from '../../wailsjs/go/models'
  import { toast, errorMessage, type StatsTab } from '../lib/state.svelte'
  import { newQueryTab, refreshStats, explainStatement, statementParams, setSampling, refreshSampling, explainQuery } from '../lib/tabs.svelte'
  import { fmtMs, fmtNum, pct } from '../lib/plan'

  interface Props { tab: StatsTab }
  let { tab }: Props = $props()

  type Key = 'totalMs' | 'calls' | 'meanMs' | 'maxMs' | 'rows' | 'hit' | 'temp' | 'ioReadMs'
  let busy = $state(false)
  let examples = $state<db.QueryExample[]>([])
  let examplesFor = $state('')

  // Keep example counts fresh while this tab is visible.
  $effect(() => {
    const t = setInterval(() => { if (tab.sampling?.running) void refreshSampling(tab) }, 2000)
    return () => clearInterval(t)
  })

  // Load examples for the expanded row, and again when counts change.
  $effect(() => {
    const key = tab.expanded
    const s = key ? (tab.data?.statements ?? []).find(s => rowKey(s) === key) : undefined
    const count = s ? tab.sampling?.counts?.[s.queryId] ?? 0 : 0
    if (!s || !count) { examples = []; examplesFor = ''; return }
    void QueryExamples(tab.connId, s.queryId).then(list => { examples = list; examplesFor = s.queryId })
  })

  function rowKey(s: db.StatStatement): string {
    return s.queryId + s.user + s.database + s.topLevel
  }

  function explainExample(ex: db.QueryExample) {
    const sql = ex.query.trim()
    const t = newQueryTab(tab.connId, sql + '\n', `stmt ${ex.queryId.slice(-6)}`)
    void explainQuery(t, sql, false)
  }

  function fmtTime(iso: string): string {
    const d = new Date(iso)
    return isNaN(d.getTime()) ? iso : d.toLocaleTimeString()
  }

  const columns: { key: Key; label: string; title: string }[] = [
    { key: 'totalMs', label: 'Total time', title: 'Total execution time across all calls' },
    { key: 'calls', label: 'Calls', title: 'Number of executions' },
    { key: 'meanMs', label: 'Mean', title: 'Mean execution time per call' },
    { key: 'maxMs', label: 'Max', title: 'Slowest single execution' },
    { key: 'rows', label: 'Rows', title: 'Total rows returned or affected' },
    { key: 'hit', label: 'Cache hit', title: 'Shared buffer hits / (hits + reads)' },
    { key: 'temp', label: 'Temp', title: 'Temp blocks written (sorts and hashes spilling to disk)' },
    { key: 'ioReadMs', label: 'I/O read', title: 'Time spent reading blocks (needs track_io_timing)' },
  ]

  function hitRatio(s: db.StatStatement): number | null {
    const total = s.sharedHit + s.sharedRead
    return total ? s.sharedHit / total : null
  }
  function value(s: db.StatStatement, k: Key): number {
    if (k === 'hit') return hitRatio(s) ?? -1
    if (k === 'temp') return s.tempWritten
    return s[k]
  }

  const rows = $derived.by(() => {
    const list = tab.data?.statements ?? []
    const f = tab.filter.trim().toLowerCase()
    const filtered = list.filter(s => (tab.includeNested || s.topLevel) && (!f || s.query.toLowerCase().includes(f) || s.user.toLowerCase().includes(f)))
    const dir = tab.sortDesc ? -1 : 1
    const k = tab.sortKey as Key
    return [...filtered].sort((a, b) => dir * (value(a, k) - value(b, k)))
  })

  function sortBy(k: Key) {
    if (tab.sortKey === k) tab.sortDesc = !tab.sortDesc
    else { tab.sortKey = k; tab.sortDesc = true }
  }

  function oneLine(q: string): string {
    return q.replace(/\s+/g, ' ').trim()
  }

  function openInEditor(s: db.StatStatement) {
    newQueryTab(tab.connId, s.query.trim() + '\n', `stmt ${s.queryId.slice(-6)}`)
  }

  async function reset() {
    if (!confirm('Reset pg_stat_statements counters for the whole server?')) return
    busy = true
    try { await ResetStatStatements(tab.connId); toast('Statistics reset'); await refreshStats(tab) }
    catch (e) { toast(errorMessage(e), 6000) } finally { busy = false }
  }

  async function install() {
    busy = true
    try { await InstallStatStatements(tab.connId); toast('Extension created'); await refreshStats(tab) }
    catch (e) { toast(errorMessage(e), 8000) } finally { busy = false }
  }

  function toggleScope() {
    tab.currentDBOnly = !tab.currentDBOnly
    void refreshStats(tab)
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
    return `${(n / 1024 ** 3).toFixed(2)} GB`
  }
</script>

<div class="stats">
  <div class="toolbar">
    <input type="text" placeholder="Filter by query text or user" bind:value={tab.filter} />
    <label class="check"><input type="checkbox" checked={tab.currentDBOnly} onchange={toggleScope} /> This database only</label>
    <label class="check" title="Statements run inside functions and procedures"><input type="checkbox" bind:checked={tab.includeNested} /> Include nested</label>
    <label class="check" title="Poll pg_stat_activity once a second to collect real statement texts, with their constants, for each query id (PostgreSQL 14+)">
      <input type="checkbox" checked={!!tab.sampling?.running} onchange={(e) => setSampling(tab, (e.currentTarget as HTMLInputElement).checked)} /> Capture examples
      {#if tab.sampling?.running}<span class="live" title="{tab.sampling.samples} samples taken"></span>{/if}
    </label>
    {#if tab.samplingError}<span class="small warn" title={tab.samplingError}>{tab.samplingError}</span>{/if}
    <span class="grow"></span>
    {#if tab.data?.available}
      <span class="muted small summary" title={tab.data.statsReset ? `Counters since ${tab.data.statsReset}` : ''}>
        {fmtNum(tab.data.totalCalls)} calls, {fmtMs(tab.data.totalMs)} total{tab.data.statsReset ? `, since ${fmtTime(tab.data.statsReset)}` : ''}
      </span>
      <button class="small" onclick={() => refreshStats(tab)} disabled={tab.loading}>↻ Refresh</button>
      <button class="small danger" onclick={reset} disabled={busy}>Reset</button>
    {/if}
  </div>

  {#if tab.error}
    <div class="pad error-text">{tab.error}</div>
  {:else if !tab.data}
    <div class="pad muted">{tab.loading ? 'Loading...' : ''}</div>
  {:else if !tab.data.available}
    <div class="pad notice">
      <p><b>pg_stat_statements is not enabled.</b></p>
      <p>{tab.data.message}</p>
      {#if tab.data.installable && tab.data.preloaded}
        <button class="primary" onclick={install} disabled={busy}>Create extension in this database</button>
      {:else}
        <pre class="mono">shared_preload_libraries = 'pg_stat_statements'   # postgresql.conf, then restart
CREATE EXTENSION pg_stat_statements;                # in each database to inspect</pre>
      {/if}
    </div>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="q">Query</th>
            {#each columns as c}
              <th class="n" onclick={() => sortBy(c.key)} title={c.title}>
                {c.label}{#if tab.sortKey === c.key}<span class="sort">{tab.sortDesc ? '▼' : '▲'}</span>{/if}
              </th>
            {/each}
            <th class="share">Share of total time</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as s (rowKey(s))}
            {@const share = tab.data.totalMs ? s.totalMs / tab.data.totalMs : 0}
            {@const hit = hitRatio(s)}
            {@const key = rowKey(s)}
            {@const exCount = tab.sampling?.counts?.[s.queryId] ?? 0}
            <tr class:open={tab.expanded === key} onclick={() => (tab.expanded = tab.expanded === key ? null : key)}>
              <td class="q" title={s.query}>
                {#if !s.topLevel}<span class="nested" title="Nested statement (inside a function)">nested</span>{/if}
                {#if exCount}<span class="excount" title="{exCount} real example{exCount === 1 ? '' : 's'} captured">{exCount}</span>{/if}
                <span class="qtext">{oneLine(s.query)}</span>
              </td>
              <td class="n">{fmtMs(s.totalMs)}</td>
              <td class="n">{fmtNum(s.calls)}</td>
              <td class="n">{fmtMs(s.meanMs)}</td>
              <td class="n">{fmtMs(s.maxMs)}</td>
              <td class="n">{fmtNum(s.rows)}</td>
              <td class="n" class:low={hit !== null && hit < 0.9}>{hit === null ? '' : pct(hit)}</td>
              <td class="n" class:low={s.tempWritten > 0}>{s.tempWritten ? fmtNum(s.tempWritten) : ''}</td>
              <td class="n">{s.ioReadMs ? fmtMs(s.ioReadMs) : ''}</td>
              <td class="share"><span class="bar" style="width: {Math.max(0.5, share * 100)}%"></span><span class="pct">{pct(share)}</span></td>
            </tr>
            {#if tab.expanded === key}
              <tr class="detail">
                <td colspan="10">
                  <pre class="sql">{s.query.trim()}</pre>
                  {#if examplesFor === s.queryId && examples.length}
                    <div class="examples">
                      <div class="exhead">Real executions seen in pg_stat_activity{tab.sampling?.maxQueryLength ? ` (text cut at ${tab.sampling.maxQueryLength} chars)` : ''}</div>
                      {#each examples as ex (ex.query)}
                        <div class="example">
                          <pre class="sql ex">{ex.query.trim()}</pre>
                          <div class="exmeta">
                            <span>{ex.count} run{ex.count === 1 ? '' : 's'}, last {fmtTime(ex.lastSeen as any)}</span>
                            <span class="grow"></span>
                            <button class="small" onclick={(e) => { e.stopPropagation(); explainExample(ex) }}>Explain</button>
                            <button class="small" onclick={(e) => { e.stopPropagation(); newQueryTab(tab.connId, ex.query.trim() + '\n', `stmt ${ex.queryId.slice(-6)}`) }}>Open in editor</button>
                            <button class="small" onclick={(e) => { e.stopPropagation(); void ClipboardSetText(ex.query); toast('Copied') }}>Copy</button>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {:else if tab.sampling?.running}
                    <div class="muted small exnone">No real execution captured yet. Examples appear once the statement runs while capture is on.</div>
                  {/if}
                  <div class="meta">
                    <span>{s.user}@{s.database}</span>
                    <span>queryid {s.queryId}</span>
                    <span>min {fmtMs(s.minMs)}</span>
                    <span>stddev {fmtMs(s.stddevMs)}</span>
                    {#if s.planMs}<span>planning {fmtMs(s.planMs)}</span>{/if}
                    <span>blocks: {fmtNum(s.sharedHit)} hit, {fmtNum(s.sharedRead)} read, {fmtNum(s.sharedDirtied)} dirtied, {fmtNum(s.sharedWritten)} written</span>
                    {#if s.tempRead || s.tempWritten}<span>temp: {fmtNum(s.tempRead)} read, {fmtNum(s.tempWritten)} written</span>{/if}
                    {#if s.walBytes}<span>WAL {fmtBytes(s.walBytes)}</span>{/if}
                    <span class="grow"></span>
                    <button class="small primary" onclick={(e) => { e.stopPropagation(); explainStatement(tab.connId, s.query, `stmt ${s.queryId.slice(-6)}`) }}
                            title={statementParams(s.query).length ? 'Explain after filling in parameter values' : 'Explain in a new tab'}>Explain</button>
                    <button class="small" onclick={(e) => { e.stopPropagation(); openInEditor(s) }}>Open in editor</button>
                    <button class="small" onclick={(e) => { e.stopPropagation(); void ClipboardSetText(s.query); toast('Copied') }}>Copy</button>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
      {#if rows.length === 0}<div class="pad muted">No statements match.</div>{/if}
    </div>
  {/if}
</div>

<style>
  .stats { height: 100%; display: flex; flex-direction: column; min-height: 0; }
  .toolbar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--bg-2); flex-shrink: 0; white-space: nowrap; }
  .toolbar .summary { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .toolbar input[type="text"] { width: 280px; padding: 3px 8px; font-size: 12px; }
  .check { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fg-2); white-space: nowrap; }
  .grow { flex: 1; }
  .small { font-size: 11.5px; }
  .pad { padding: 14px 16px; }
  .notice p { margin: 0 0 8px; }
  .notice pre { margin-top: 8px; padding: 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
  .table-wrap { flex: 1; overflow: auto; min-height: 0; }
  table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12px; }
  th, td { padding: 4px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--bg-2); font-weight: 600; font-size: 11px; color: var(--fg-2); z-index: 1; }
  th.n { cursor: pointer; user-select: none; }
  th.n:hover { background: var(--bg-hover); }
  .sort { color: var(--accent); font-size: 9px; margin-left: 3px; }
  td.q { max-width: 0; width: 45%; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); cursor: default; }
  .qtext { overflow: hidden; text-overflow: ellipsis; }
  .nested { font-size: 9px; text-transform: uppercase; color: var(--fg-3); border: 1px solid var(--border); border-radius: 3px; padding: 0 3px; margin-right: 6px; }
  td.n, th.n { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  td.low { color: var(--warn); }
  .share { width: 180px; }
  td.share { display: flex; align-items: center; gap: 6px; border-bottom: none; }
  .bar { display: inline-block; height: 8px; border-radius: 2px; background: var(--accent); max-width: 120px; flex-shrink: 0; }
  .pct { font-size: 11px; color: var(--fg-2); font-family: var(--font-mono); }
  tbody tr:hover td { background: var(--bg-hover); }
  tbody tr.open td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  tr.detail td { white-space: normal; background: var(--bg-2) !important; padding: 8px 12px; }
  .sql { margin: 0 0 8px; padding: 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow: auto; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; font-size: 11.5px; color: var(--fg-2); }
  .live { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); margin-left: 4px; animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .warn { color: var(--warn); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .excount { font-size: 10px; font-weight: 600; color: var(--ok); background: color-mix(in srgb, var(--ok) 18%, transparent); border-radius: 8px; padding: 0 5px; margin-right: 6px; }
  .examples { margin: 0 0 8px; }
  .exhead { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-2); margin: 4px 0 6px; }
  .example { border-left: 3px solid var(--ok); padding-left: 8px; margin-bottom: 8px; }
  .sql.ex { margin: 0 0 4px; max-height: 160px; }
  .exmeta { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--fg-2); }
  .exnone { margin-bottom: 8px; }
</style>
