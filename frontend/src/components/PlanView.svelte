<script lang="ts">
  import { tick } from 'svelte'
  import { ClipboardSetText } from '../../wailsjs/runtime/runtime'
  import { ResolveTables } from '../../wailsjs/go/main/App'
  import type { db } from '../../wailsjs/go/models'
  import { toast, serverMajor, type QueryTab } from '../lib/state.svelte'
  import { parsePlan, fmtMs, fmtNum, pct, detailEntries, type PlanNode, type ParsedPlan } from '../lib/plan'
  import { analyzePlan, type Analysis } from '../lib/hints'
  import { sqlFacts } from '../lib/sqlast'
  import { parseSql, SqlSyntaxError } from '../lib/pgquery'
  import { errorMessage } from '../lib/state.svelte'
  import PlanDiagram from './PlanDiagram.svelte'
  import JoinDiagram from './JoinDiagram.svelte'
  import HintsPanel from './HintsPanel.svelte'
  import Splitter from './Splitter.svelte'

  interface Props { tab: QueryTab }
  let { tab }: Props = $props()

  let mode = $state<'diagram' | 'joins' | 'tree' | 'json'>('diagram')
  let expanded = $state<Record<number, boolean>>({})
  let collapsed = $state<Record<number, boolean>>({})

  // The hints panel is open by default; its state is remembered between launches.
  let showHints = $state(true)
  let hintsWidth = $state(380)
  try {
    const saved = JSON.parse(localStorage.getItem('pginspect.hints') ?? '{}')
    if (typeof saved.open === 'boolean') showHints = saved.open
    if (typeof saved.width === 'number') hintsWidth = Math.max(240, Math.min(800, saved.width))
  } catch { /* defaults */ }
  function saveHints() {
    try { localStorage.setItem('pginspect.hints', JSON.stringify({ open: showHints, width: hintsWidth })) } catch { /* ignore */ }
  }
  function toggleHints() { showHints = !showHints; saveHints() }

  let analysis = $state<Analysis | null>(null)
  let parseStatus = $state('')
  /** Plan node a hint asked to show; drives selection in the diagram and the table. */
  let focusId = $state<number | null>(null)

  const parsed = $derived.by((): { plan?: ParsedPlan; error?: string } => {
    if (!tab.plan?.plan) return {}
    try { return { plan: parsePlan(tab.plan.plan) } } catch (e) { return { error: String(e) } }
  })

  $effect(() => { tab.plan; expanded = {}; collapsed = {}; focusId = null })

  // Analyse each new plan: resolve the tables it names, parse the statement,
  // then run the rules. The parser is a lazily loaded wasm module.
  $effect(() => {
    const p = parsed.plan
    const sql = tab.plan?.sql ?? ''
    const connId = tab.connId
    analysis = null
    parseStatus = ''
    if (!p) return
    let stale = false
    void (async () => {
      let tables: db.TableColumns[] = []
      const names = [...new Set(p.nodes.map(n => n.raw['Relation Name']).filter(Boolean))] as string[]
      if (names.length) {
        try { tables = await ResolveTables(connId, names) } catch { /* hints then work from the plan alone */ }
      }
      const columns = (schema: string | null, table: string) => {
        const c = tables.filter(t => t.name === table && (!schema || t.schema === schema))
        return c.length === 1 ? c[0].columns : undefined
      }
      const schemaOf = (table: string) => {
        const c = tables.filter(t => t.name === table)
        return c.length === 1 ? c[0].schema : null
      }
      let facts = null, status = ''
      if (sql.trim()) {
        try { facts = sqlFacts(await parseSql(sql), columns) }
        catch (e) { status = e instanceof SqlSyntaxError ? `Statement text not parsed (${e.message} at ${e.position}); hints use the plan only.` : `Statement text not parsed (${errorMessage(e)}); hints use the plan only.` }
      }
      if (stale) return
      analysis = analyzePlan(p, { facts, serverMajor: serverMajor(connId), schemaOf })
      parseStatus = status
    })()
    return () => { stale = true }
  })

  const topSeverity = $derived(analysis?.hints[0]?.severity ?? null)

  async function focusNode(id: number) {
    focusId = id
    if (mode === 'json' || mode === 'joins') mode = 'diagram'
    if (mode === 'tree') {
      // Unfold ancestors so the row exists, then scroll to it.
      if (parsed.plan) {
        const path = new Set<number>()
        const find = (n: PlanNode, trail: number[]): boolean => {
          if (n.id === id) { trail.forEach(t => path.add(t)); return true }
          return n.children.some(c => find(c, [...trail, n.id]))
        }
        find(parsed.plan.root, [])
        for (const a of path) collapsed[a] = false
      }
      expanded[id] = true
      await tick()
      document.getElementById(`plan-node-${id}`)?.scrollIntoView({ block: 'center' })
    }
  }

  /** Nodes in display order, skipping children of collapsed nodes. */
  const visible = $derived.by(() => {
    const out: PlanNode[] = []
    const walk = (n: PlanNode) => { out.push(n); if (!collapsed[n.id]) n.children.forEach(walk) }
    if (parsed.plan) walk(parsed.plan.root)
    return out
  })

  function share(n: PlanNode, p: ParsedPlan): number {
    if (p.analyze) return p.totalTime ? (n.exclTime ?? 0) / p.totalTime : 0
    return p.totalCost ? n.exclCost / p.totalCost : 0
  }

  function heat(f: number): string {
    if (f >= 0.5) return 'var(--danger)'
    if (f >= 0.2) return 'var(--warn)'
    return 'var(--accent)'
  }

  function rowsCell(n: PlanNode): string {
    if (n.actualRows === null) return fmtNum(n.planRows)
    return `${fmtNum(n.actualRows)}${n.loops > 1 ? ` x${fmtNum(n.loops)}` : ''}`
  }

  function copyJson() {
    if (tab.plan?.plan) { void ClipboardSetText(tab.plan.plan); toast('Plan JSON copied') }
  }
</script>

<div class="plan">
  {#if tab.running}
    <div class="pad"><span class="spinner"></span> {tab.plan?.analyze === false ? 'Planning...' : 'Explaining...'}</div>
  {:else if !tab.plan}
    <div class="pad muted">No plan yet.</div>
  {:else if tab.plan.error}
    <div class="error-box"><div class="error-text">{tab.plan.cancelled ? 'Explain cancelled.' : tab.plan.error}</div></div>
  {:else if parsed.error}
    <div class="error-box"><div class="error-text">Could not parse plan: {parsed.error}</div></div>
    <pre class="json">{tab.plan.plan}</pre>
  {:else if parsed.plan}
    {@const p = parsed.plan}
    <div class="summary">
      <span class="mode" class:analyze={p.analyze}>{p.analyze ? 'EXPLAIN ANALYZE' : tab.plan.generic ? 'GENERIC PLAN' : 'EXPLAIN'}</span>
      {#if tab.plan.generic}<span class="muted" title="Planned without parameter values, so selectivity estimates use defaults rather than statistics for specific values.">parameters unbound</span>{/if}
      {#if p.analyze}
        <span><b>{fmtMs(p.executionTime)}</b> execution</span>
        <span class="muted">{fmtMs(p.planningTime)} planning</span>
        {#if p.sharedHit || p.sharedRead}
          <span class="muted" title="8 kB blocks">buffers: {fmtNum(p.sharedHit)} hit, {fmtNum(p.sharedRead)} read{p.tempWritten ? `, ${fmtNum(p.tempWritten)} temp written` : ''}</span>
        {/if}
      {:else}
        <span><b>{fmtNum(Math.round(p.totalCost))}</b> total cost</span>
        {#if p.planningTime !== null}<span class="muted">{fmtMs(p.planningTime)} planning</span>{/if}
      {/if}
      <span class="grow"></span>
      <button class="small" class:active={mode === 'diagram'} onclick={() => (mode = 'diagram')}>Diagram</button>
      <button class="small" class:active={mode === 'joins'} onclick={() => (mode = 'joins')} title="Tables and join conditions">Joins</button>
      <button class="small" class:active={mode === 'tree'} onclick={() => (mode = 'tree')}>Table</button>
      <button class="small" class:active={mode === 'json'} onclick={() => (mode = 'json')}>JSON</button>
      <button class="small" onclick={copyJson}>Copy JSON</button>
      <span class="sep"></span>
      <button class="small hints-btn" class:active={showHints} onclick={toggleHints} title="Optimisation hints and row flow">
        Hints{#if analysis}<span class="count {topSeverity ?? 'none'}">{analysis.hints.length}</span>{/if}
      </button>
    </div>

    <div class="body">
    <div class="main">
    {#if mode === 'json'}
      <pre class="json">{JSON.stringify(JSON.parse(tab.plan.plan), null, 2)}</pre>
    {:else if mode === 'diagram'}
      <div class="diagram-pane"><PlanDiagram plan={p} title={tab.plan.analyze ? 'Executed plan' : 'Estimated plan'} focus={focusId} /></div>
    {:else if mode === 'joins'}
      <div class="diagram-pane"><JoinDiagram plan={p} /></div>
    {:else}
      <div class="tree">
        <div class="row head">
          <span class="c-node">Node</span>
          <span class="c-num">{p.analyze ? 'Rows' : 'Est. rows'}</span>
          {#if p.analyze}<span class="c-num">Est.</span>{/if}
          <span class="c-num">{p.analyze ? 'Time (self)' : 'Cost (self)'}</span>
          <span class="c-bar">{p.analyze ? 'Share of execution time' : 'Share of total cost'}</span>
        </div>
        {#each visible as n (n.id)}
          {@const f = share(n, p)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="row" id="plan-node-{n.id}" class:open={expanded[n.id]} class:focused={focusId === n.id} onclick={() => (expanded[n.id] = !expanded[n.id])} role="button" tabindex="-1">
            <span class="c-node" style="padding-left: {n.depth * 18}px">
              {#if n.children.length}
                <button class="caret" onclick={(e) => { e.stopPropagation(); collapsed[n.id] = !collapsed[n.id] }} title={collapsed[n.id] ? 'Expand' : 'Collapse'}>
                  {collapsed[n.id] ? '▸' : '▾'}
                </button>
              {:else}<span class="caret"></span>{/if}
              {#if n.role}<span class="role">{n.role}</span>{/if}
              <span class="ntype" class:seq={n.type === 'Seq Scan'}>{n.type}</span>
              <span class="ndetail">{n.detail}</span>
              {#if n.warnings.length}<span class="flag" title={n.warnings.join('\n')}>⚠ {n.warnings.length}</span>{/if}
            </span>
            <span class="c-num">{rowsCell(n)}</span>
            {#if p.analyze}<span class="c-num muted">{fmtNum(n.planRows)}</span>{/if}
            <span class="c-num">{p.analyze ? fmtMs(n.exclTime) : fmtNum(Math.round(n.exclCost))}</span>
            <span class="c-bar"><span class="bar" style="width: {Math.max(0.5, f * 100)}%; background: {heat(f)}"></span><span class="pct">{pct(f)}</span></span>
          </div>
          {#if expanded[n.id]}
            <div class="details" style="padding-left: {n.depth * 18 + 36}px">
              {#if p.analyze}
                <div><span class="k">Inclusive time</span><span class="v">{fmtMs(n.inclTime)}{n.loops > 1 ? ` over ${fmtNum(n.loops)} loops (${fmtMs((n.inclTime ?? 0) / n.loops)} each)` : ''}</span></div>
              {/if}
              <div><span class="k">Cost</span><span class="v">{n.raw['Startup Cost']}..{n.raw['Total Cost']}, width {n.raw['Plan Width']}</span></div>
              {#each detailEntries(n.raw) as [k, v]}
                <div><span class="k">{k}</span><span class="v">{v}</span></div>
              {/each}
            </div>
          {/if}
        {/each}
      </div>
      {#if p.triggers?.length}
        <h4>Triggers</h4>
        <pre class="json">{JSON.stringify(p.triggers, null, 2)}</pre>
      {/if}
      {#if p.settings && Object.keys(p.settings).length}
        <div class="settings muted">Non-default settings: {Object.entries(p.settings).map(([k, v]) => `${k} = ${v}`).join(', ')}</div>
      {/if}
    {/if}
    </div>
    {#if showHints}
      <Splitter direction="horizontal" onDrag={(d) => { hintsWidth = Math.max(240, Math.min(800, hintsWidth - d)); saveHints() }} />
      <div class="side" style="width: {hintsWidth}px">
        <HintsPanel plan={p} {analysis} {parseStatus} focused={focusId} onFocus={focusNode} onClose={toggleHints} />
      </div>
    {/if}
    </div>
  {/if}
</div>

<style>
  .plan { height: 100%; overflow: hidden; background: var(--bg); font-size: 12.5px; display: flex; flex-direction: column; }
  .plan > :global(*) { flex-shrink: 0; }
  .body { flex: 1 1 auto; min-height: 0; display: flex; }
  .main { flex: 1 1 auto; min-width: 0; overflow: auto; display: flex; flex-direction: column; }
  .main > :global(*) { flex-shrink: 0; }
  .side { flex-shrink: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; border-left: 1px solid var(--border); }
  .side > :global(*) { flex: 1; min-height: 0; }
  .diagram-pane { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  .pad { padding: 16px; display: flex; gap: 8px; align-items: center; }
  .error-box { padding: 10px 14px; background: color-mix(in srgb, var(--danger) 8%, var(--bg)); }
  .summary { display: flex; align-items: center; gap: 14px; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--bg-2); }
  .sep { width: 1px; height: 14px; background: var(--border); margin: 0 -6px; }
  .hints-btn { display: inline-flex; align-items: center; gap: 6px; }
  .count { font-size: 10px; font-weight: 700; padding: 0 5px; border-radius: 8px; background: var(--bg-3); color: var(--fg-2); }
  .count.high { background: var(--danger); color: var(--accent-fg); }
  .count.medium { background: var(--warn); color: var(--bg); }
  .summary button.active .count { background: color-mix(in srgb, var(--accent-fg) 25%, transparent); color: var(--accent-fg); }
  .mode { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; padding: 2px 6px; border-radius: 3px; background: var(--bg-3); color: var(--fg-2); }
  .mode.analyze { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .grow { flex: 1; }
  .summary button.active { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .tree { padding-bottom: 12px; min-width: 760px; }
  .row { display: grid; grid-template-columns: minmax(300px, 1fr) 110px 90px 110px 220px; align-items: center; padding: 3px 12px; border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent); cursor: default; }
  .row:hover { background: var(--bg-hover); }
  .row.head { position: sticky; top: 0; background: var(--bg-2); font-size: 11px; color: var(--fg-2); font-weight: 600; z-index: 1; cursor: default; }
  .row.open { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .row.focused { box-shadow: inset 3px 0 0 var(--accent); }
  .c-node { display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; overflow: hidden; }
  .c-num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; padding-right: 8px; }
  .caret { width: 14px; border: none; background: transparent; padding: 0; color: var(--fg-3); font-size: 10px; text-align: left; flex-shrink: 0; }
  .role { font-size: 10px; color: var(--syn-keyword); background: color-mix(in srgb, var(--syn-keyword) 15%, transparent); padding: 1px 5px; border-radius: 3px; }
  .ntype { font-weight: 600; }
  .ntype.seq { color: var(--warn); }
  .ndetail { color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: 12px; }
  .flag { color: var(--warn); font-size: 11px; }
  .c-bar { display: flex; align-items: center; gap: 6px; }
  .bar { display: inline-block; height: 8px; border-radius: 2px; min-width: 2px; max-width: 160px; flex-shrink: 0; }
  .pct { font-size: 11px; color: var(--fg-2); font-family: var(--font-mono); }
  .details { padding: 4px 12px 8px; background: var(--bg-2); border-bottom: 1px solid var(--border); display: grid; grid-template-columns: max-content 1fr; column-gap: 14px; row-gap: 2px; font-size: 12px; }
  .details > div { display: contents; }
  .k { color: var(--fg-2); }
  .v { font-family: var(--font-mono); white-space: pre-wrap; word-break: break-word; }
  .json { margin: 12px; padding: 12px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; font-family: var(--font-mono); font-size: 12px; overflow: auto; }
  h4 { margin: 12px 12px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-2); }
  .settings { padding: 8px 12px; font-size: 11.5px; }
  .spinner { width: 12px; height: 12px; border: 2px solid var(--fg-3); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
