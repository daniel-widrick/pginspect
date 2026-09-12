<script lang="ts">
  // Logged statement executions read from the server's log files: the only
  // place PostgreSQL records the actual argument values of a slow statement.
  import { ClipboardSetText } from '../../wailsjs/runtime/runtime'
  import type { db } from '../../wailsjs/go/models'
  import { toast, type SlowLogTab } from '../lib/state.svelte'
  import { newQueryTab, refreshSlowLog, explainQuery, explainStatement, statementParams } from '../lib/tabs.svelte'
  import { fmtMs, fmtNum } from '../lib/plan'

  interface Props { tab: SlowLogTab }
  let { tab }: Props = $props()

  /** Parse and bind phases are logged separately but say nothing about the execution. */
  let showPhases = $state(false)

  const rows = $derived.by(() => {
    const list = tab.data?.entries ?? []
    const f = tab.filter.trim().toLowerCase()
    return list.filter(e => (showPhases || e.command === 'statement' || e.command === 'execute')
      && e.durationMs >= tab.minMs && (!f || e.query.toLowerCase().includes(f) || e.user.toLowerCase().includes(f) || e.app.toLowerCase().includes(f) || e.queryId === f))
  })

  function oneLine(q: string): string {
    return q.replace(/\s+/g, ' ').trim()
  }

  /** The statement with its logged values in place of the placeholders. */
  function filled(e: db.SlowLogEntry): string {
    let q = e.query
    for (const [k, v] of Object.entries(e.params ?? {})) {
      q = q.replace(new RegExp('\\' + k + '\\b', 'g'), v)
    }
    return q
  }

  function explain(e: db.SlowLogEntry, analyze: boolean) {
    const sql = filled(e).trim()
    const title = `logged ${fmtMs(e.durationMs)}`
    if (statementParams(sql).length) {
      // Some placeholders had no logged value (log_parameter_max_length cut
      // them, or the log line predates parameter logging): ask for them.
      explainStatement(tab.connId, sql, title)
      return
    }
    const t = newQueryTab(tab.connId, sql + '\n', title)
    void explainQuery(t, sql, analyze)
  }

  function fmtTime(t: string): string {
    const d = new Date(t)
    return isNaN(d.getTime()) ? t : d.toLocaleString()
  }

  function loadMore() {
    tab.maxBytes *= 4
    void refreshSlowLog(tab)
  }

  const status = $derived(tab.data?.status)
</script>

<div class="slowlog">
  <div class="toolbar">
    <input type="text" placeholder="Filter by text, user, application or query id" bind:value={tab.filter} />
    <label class="check">Slower than
      <select bind:value={tab.minMs}>
        {#each [0, 10, 100, 500, 1000, 5000] as ms}<option value={ms}>{ms === 0 ? 'any' : fmtMs(ms)}</option>{/each}
      </select>
    </label>
    <label class="check" title="Also list the parse and bind phases of extended-protocol statements"><input type="checkbox" bind:checked={showPhases} /> Parse and bind</label>
    <span class="grow"></span>
    {#if status?.readable}
      <span class="muted small" title="log_min_duration_statement={status.logMinDurationStatement} · log_destination={status.logDestination} · {status.files} files">
        {status.format} log · threshold {status.logMinDurationStatement === '0' ? 'all statements' : status.logMinDurationStatement === '-1' ? 'off' : status.logMinDurationStatement + (/\d$/.test(status.logMinDurationStatement) ? ' ms' : '')}
        {#if tab.data}· read {fmtNum(Math.round(tab.data.bytesRead / 1024))} kB{/if}
      </span>
      {#if tab.data && !tab.data.complete}<button class="small" onclick={loadMore} disabled={tab.loading}>Read more</button>{/if}
      <button class="small" onclick={() => refreshSlowLog(tab)} disabled={tab.loading}>↻ Refresh</button>
    {/if}
  </div>

  {#if tab.error}
    <div class="pad error-text">{tab.error}</div>
  {:else if !tab.data}
    <div class="pad muted">{tab.loading ? 'Reading the server log...' : ''}</div>
  {:else if !status?.readable || !status?.format}
    <div class="pad notice">
      <p><b>The statement log cannot be read from here.</b></p>
      <p>{status?.message}</p>
      <pre class="mono">logging_collector = on                 # postgresql.conf, restart
log_destination = 'jsonlog'            # or csvlog; reloadable
log_min_duration_statement = '500ms'   # reloadable
GRANT pg_monitor TO {'{'}role{'}'};              # lets pginspect list and read the log files</pre>
      <p class="muted">Every execution slower than the threshold is then logged with its real parameter values, which is what this tab shows.</p>
    </div>
  {:else}
    {#if status.message}
      <div class="hint">{status.message}</div>
    {/if}
    <div class="table-wrap">
      <table>
        <thead><tr><th>When</th><th class="n">Duration</th><th>Who</th><th class="q">Statement</th><th class="n">Values</th><th>Query id</th></tr></thead>
        <tbody>
          {#each rows as e, i (i)}
            {@const nparams = Object.keys(e.params ?? {}).length}
            <tr class:open={tab.expanded === i} onclick={() => (tab.expanded = tab.expanded === i ? null : i)}>
              <td class="nowrap">{fmtTime(e.time as any)}</td>
              <td class="n" class:slow={e.durationMs >= 1000}>{fmtMs(e.durationMs)}</td>
              <td class="nowrap muted" title="{e.app} · pid {e.pid}">{e.user}@{e.database}</td>
              <td class="q" title={e.query}><span class="cmd">{e.command}</span> {oneLine(e.query)}</td>
              <td class="n">{nparams ? nparams : ''}</td>
              <td class="muted small nowrap">{e.queryId ? `#${e.queryId.slice(-6)}` : ''}</td>
            </tr>
            {#if tab.expanded === i}
              <tr class="detail">
                <td colspan="6">
                  <pre class="sql">{filled(e)}</pre>
                  {#if nparams}
                    <div class="params">
                      {#each Object.entries(e.params ?? {}).sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1))) as [k, v]}
                        <span class="param"><b>{k}</b> = {v}</span>
                      {/each}
                    </div>
                  {/if}
                  <div class="meta">
                    <span>{fmtTime(e.time as any)} · {e.user}@{e.database} · {e.app || 'no application_name'} · pid {e.pid}</span>
                    {#if e.queryId}<span>query id {e.queryId}</span>{/if}
                    <span class="muted">{e.file}</span>
                    <span class="grow"></span>
                    <button class="small primary" onclick={(ev) => { ev.stopPropagation(); explain(e, false) }}>Explain</button>
                    <button class="small" onclick={(ev) => { ev.stopPropagation(); explain(e, true) }} title="Runs the statement with these values inside a transaction that is rolled back">Explain Analyze</button>
                    <button class="small" onclick={(ev) => { ev.stopPropagation(); newQueryTab(tab.connId, filled(e).trim() + '\n', `logged ${fmtMs(e.durationMs)}`) }}>Open in editor</button>
                    <button class="small" onclick={(ev) => { ev.stopPropagation(); void ClipboardSetText(filled(e)); toast('Copied with values') }}>Copy</button>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
      {#if rows.length === 0}<div class="pad muted">No logged executions match.</div>{/if}
    </div>
  {/if}
</div>

<style>
  .slowlog { height: 100%; display: flex; flex-direction: column; min-height: 0; }
  .toolbar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--bg-2); flex-shrink: 0; white-space: nowrap; }
  .toolbar input[type="text"] { width: 300px; padding: 3px 8px; font-size: 12px; }
  .check { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fg-2); }
  .check select { width: auto; padding: 2px 6px; font-size: 12px; }
  .grow { flex: 1; }
  .small { font-size: 11.5px; }
  .pad { padding: 14px 16px; }
  .notice p { margin: 0 0 8px; }
  .notice pre { margin: 8px 0; padding: 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
  .hint { padding: 6px 12px; font-size: 12px; color: var(--fg-2); background: color-mix(in srgb, var(--warn) 10%, var(--bg)); border-bottom: 1px solid var(--border); }
  .table-wrap { flex: 1; overflow: auto; min-height: 0; }
  table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12px; }
  th, td { padding: 4px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--bg-2); font-weight: 600; font-size: 11px; color: var(--fg-2); z-index: 1; }
  td.q, th.q { max-width: 0; width: 55%; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); cursor: default; }
  .cmd { font-size: 10px; text-transform: uppercase; color: var(--fg-3); margin-right: 4px; }
  td.n, th.n { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  td.slow { color: var(--danger); font-weight: 600; }
  .nowrap { white-space: nowrap; }
  tbody tr:hover td { background: var(--bg-hover); }
  tbody tr.open td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  tr.detail td { white-space: normal; background: var(--bg-2) !important; padding: 8px 12px; }
  .sql { margin: 0 0 8px; padding: 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow: auto; }
  .params { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 8px; font-family: var(--font-mono); font-size: 11.5px; }
  .param b { color: var(--accent); font-weight: 600; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; font-size: 11.5px; color: var(--fg-2); }
</style>
