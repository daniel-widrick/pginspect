<script lang="ts" module>
  // Remembered for the session so a repeat export keeps the last choices.
  const last = $state({ useTop: true, top: 20, useSlow: true, slowSeconds: 1, readSlowLog: true, examples: 3, explain: true, analyze: false, analyzeTimeout: 30, tables: true })
</script>

<script lang="ts">
  import { ClipboardSetText } from '../../wailsjs/runtime/runtime'
  import { StatsReport, SaveTextFile, CancelQuery } from '../../wailsjs/go/main/App'
  import { db } from '../../wailsjs/go/models'
  import { toast, errorMessage, store, type StatsTab } from '../lib/state.svelte'

  interface Props { tab: StatsTab; onclose: () => void }
  let { tab, onclose }: Props = $props()

  let busy = $state(false)
  let error = $state('')

  const valid = $derived((last.useTop && last.top > 0) || (last.useSlow && last.slowSeconds > 0))
  const capturing = $derived(!!tab.sampling?.running || (tab.sampling?.samples ?? 0) > 0)

  async function build(): Promise<string | null> {
    busy = true
    error = ''
    try {
      return await StatsReport(tab.connId, db.ReportOptions.createFrom({
        topByTotal: last.useTop ? Math.floor(last.top) : 0,
        minMaxSeconds: last.useSlow ? last.slowSeconds : 0,
        currentDBOnly: tab.currentDBOnly,
        includeNested: tab.includeNested,
        readSlowLog: last.readSlowLog,
        examples: Math.max(1, Math.floor(last.examples)),
        explain: last.explain,
        analyze: last.explain && last.analyze,
        analyzeTimeoutSeconds: last.analyzeTimeout > 0 ? last.analyzeTimeout : 30,
        tables: last.explain && last.tables,
      }))
    } catch (e) {
      error = errorMessage(e)
      return null
    } finally {
      busy = false
    }
  }

  function fileName(): string {
    const name = store.connected[tab.connId]?.database || 'postgres'
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    return `statements-${name.replace(/[^\w.-]+/g, '_')}-${stamp}.md`
  }

  // Matches db.ReportQueryID.
  function cancelBuild() { void CancelQuery(tab.connId, 'stats-report') }

  function close() {
    if (busy) cancelBuild()
    onclose()
  }

  async function save() {
    const text = await build()
    if (text === null) return
    try {
      const path = await SaveTextFile(text, fileName(), 'Markdown', '*.md')
      if (path) { toast(`Report saved to ${path}`); onclose() }
    } catch (e) { error = errorMessage(e) }
  }

  async function copy() {
    const text = await build()
    if (text === null) return
    await ClipboardSetText(text)
    toast(`Report copied (${Math.round(text.length / 1024)} kB)`)
    onclose()
  }
</script>

<div class="backdrop" onclick={close} onkeydown={(e) => e.key === 'Escape' && close()} role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <form class="dialog" onclick={(e) => e.stopPropagation()} onsubmit={(e) => { e.preventDefault(); void save() }}>
    <h2>Export statement report</h2>
    <p class="muted">
      A Markdown report of the chosen statements: counters, server settings, example executions with
      real parameter values, plans and the tables they read. Written to be handed to an agent or a reviewer.
    </p>

    <label class="row">
      <input type="checkbox" bind:checked={last.useTop} />
      Top <input type="number" min="1" max="500" bind:value={last.top} disabled={!last.useTop} /> statements by total time
    </label>
    <label class="row">
      <input type="checkbox" bind:checked={last.useSlow} />
      Every statement with a single run of <input type="number" min="0.001" step="any" bind:value={last.slowSeconds} disabled={!last.useSlow} /> s or longer
    </label>

    <div class="sep"></div>

    <label class="row">
      <input type="checkbox" bind:checked={last.explain} />
      Include an EXPLAIN plan for each statement, from a real execution where one was seen
    </label>
    <label class="row sub" title="Each read-only statement with real parameter values runs once, inside a transaction that is rolled back. Statements that write, and statements with no known values, get an estimated plan only.">
      <input type="checkbox" bind:checked={last.analyze} disabled={!last.explain} />
      Use EXPLAIN ANALYZE for read-only statements, at most
      <input type="number" min="1" step="any" bind:value={last.analyzeTimeout} disabled={!last.explain || !last.analyze} /> s each
    </label>
    <label class="row sub">
      <input type="checkbox" bind:checked={last.tables} disabled={!last.explain} />
      Include definitions, indexes and statistics of the tables the plans read
    </label>
    {#if last.explain && last.analyze}
      <div class="warn small sub">ANALYZE really runs each SELECT against this server, including any functions it calls. Prefer a replica or a quiet period on a busy primary.</div>
    {/if}

    <div class="sep"></div>

    <label class="row">
      <input type="checkbox" bind:checked={last.readSlowLog} />
      Read the server log for executions with parameter values
    </label>
    <label class="row">
      Up to <input type="number" min="1" max="20" bind:value={last.examples} /> examples per statement
    </label>

    <ul class="notes muted">
      <li>Scope follows this tab: {tab.currentDBOnly ? 'this database only' : 'all databases'}, {tab.includeNested ? 'nested statements included' : 'top-level statements only'}. The text filter is not applied.</li>
      {#if !capturing}
        <li>"Capture examples" has not run on this connection, so only logged executions can supply values.</li>
      {/if}
    </ul>

    {#if error}<div class="error-text small">{error}</div>{/if}

    <div class="buttons">
      <button type="button" onclick={busy ? cancelBuild : onclose}>{busy ? 'Stop' : 'Cancel'}</button>
      <span class="spacer"></span>
      {#if busy}<span class="muted small">{last.explain ? 'Explaining statements...' : 'Building report...'}</span>{/if}
      <button type="button" onclick={copy} disabled={!valid || busy}>Copy to clipboard</button>
      <button type="submit" class="primary" disabled={!valid || busy}>Save as Markdown...</button>
    </div>
  </form>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .dialog { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; width: 560px; max-width: 95vw; max-height: 90vh; overflow: auto; box-shadow: 0 12px 40px rgba(0,0,0,0.3); display: flex; flex-direction: column; gap: 10px; }
  h2 { margin: 0; font-size: 15px; }
  p { margin: 0; font-size: 12px; }
  .row { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
  .row input[type="number"] { width: 70px; padding: 2px 6px; font-family: var(--font-mono); }
  .sub { margin-left: 22px; }
  .warn { color: var(--warn); }
  .sep { border-top: 1px solid var(--border); margin: 2px 0; }
  .notes { margin: 0; padding-left: 18px; font-size: 11.5px; display: flex; flex-direction: column; gap: 3px; }
  .small { font-size: 11.5px; }
  .buttons { display: flex; gap: 6px; margin-top: 4px; align-items: center; }
  .spacer { flex: 1; }
</style>
