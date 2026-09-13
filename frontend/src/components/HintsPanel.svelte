<script lang="ts">
  // Optimisation hints and the row-flow table for a plan. Hints come from
  // the analyser in lib/hints.ts; this only presents them and lets the user
  // jump to the plan node each one is about.
  import { ClipboardSetText } from '../../wailsjs/runtime/runtime'
  import { toast } from '../lib/state.svelte'
  import { fmtNum, pct, type ParsedPlan, type PlanNode } from '../lib/plan'
  import type { Analysis, Hint, Severity } from '../lib/hints'

  interface Props {
    plan: ParsedPlan
    analysis: Analysis | null
    /** Why the statement text could not be used, if it could not. */
    parseStatus: string
    focused: number | null
    onFocus: (id: number) => void
    onClose: () => void
  }
  let { plan, analysis, parseStatus, focused, onFocus, onClose }: Props = $props()

  let openFix = $state<Record<string, boolean>>({})
  let showFlow = $state(true)

  const severityLabel: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' }
  const categoryLabel: Record<string, string> = { index: 'Index', statistics: 'Statistics', memory: 'Memory', rewrite: 'Rewrite', rowflow: 'Row flow', config: 'Config', maintenance: 'Maintenance' }

  function node(id: number | null): PlanNode | null {
    return id === null ? null : plan.nodes.find(n => n.id === id) ?? null
  }

  function nodeLabel(n: PlanNode): string {
    return n.type + (n.detail ? ' ' + n.detail : '')
  }

  function copy(text: string) {
    void ClipboardSetText(text)
    toast('Copied')
  }

  function key(h: Hint, i: number): string { return `${h.id}:${h.nodeId ?? 'q'}:${i}` }

  /** Steps worth showing: anything that changed the row count, plus joins. Capped for huge plans. */
  const flowRows = $derived.by(() => {
    if (!analysis) return []
    const steps = analysis.flow.filter(s => s.rowsIn > 0 && (Math.round(s.rowsIn) !== Math.round(s.rowsOut) || ['Nested Loop', 'Hash Join', 'Merge Join'].includes(s.node.type)))
    if (steps.length <= 40) return steps
    const keep = new Set([...steps].sort((a, b) => Math.abs(b.rowsIn - b.rowsOut) - Math.abs(a.rowsIn - a.rowsOut)).slice(0, 40).map(s => s.node.id))
    return steps.filter(s => keep.has(s.node.id))
  })

  const maxFlow = $derived(Math.max(1, ...flowRows.map(s => Math.max(s.rowsIn, s.rowsOut))))

  /** Bar width on a log scale so a 1M-row scan and a 10-row lookup both stay visible. */
  function bar(rows: number): number {
    if (rows <= 0) return 0
    return Math.max(2, (100 * Math.log10(rows + 1)) / Math.log10(maxFlow + 1))
  }
</script>

<div class="panel">
  <div class="head">
    <b>Hints</b>
    {#if analysis}
      {#each ['high', 'medium', 'low'] as const as sev}
        {@const n = analysis.hints.filter(h => h.severity === sev).length}
        {#if n}<span class="chip {sev}">{n} {severityLabel[sev].toLowerCase()}</span>{/if}
      {/each}
    {/if}
    <span class="grow"></span>
    <button class="ghost small" onclick={onClose} title="Hide hints">✕</button>
  </div>

  {#if !analysis}
    <div class="pad muted">Analysing...</div>
  {:else}
    {#if parseStatus}
      <div class="status muted" title="Hints that need the query text (NOT IN, OFFSET, CTE declarations, column resolution) are skipped; the rest use the plan alone.">{parseStatus}</div>
    {/if}
    {#if analysis.hints.length === 0}
      <div class="pad muted">Nothing to suggest. The plan has no pattern the analyser recognises as improvable: filters run where the rows are read, joins are keyed, sorts and hashes fit in memory, and estimates match.</div>
    {/if}
    <div class="list">
      {#each analysis.hints as h, i (key(h, i))}
        {@const n = node(h.nodeId)}
        <div class="hint {h.severity}" class:focused={n !== null && focused === n.id}>
          <div class="title">
            <span class="sev {h.severity}" title="{severityLabel[h.severity]} impact">{severityLabel[h.severity]}</span>
            <span class="cat">{categoryLabel[h.category] ?? h.category}</span>
            <span class="ttext">{h.title}</span>
          </div>
          {#if n}
            <button class="node" onclick={() => onFocus(n.id)} title="Show this node in the plan">↳ {nodeLabel(n)}</button>
          {/if}
          {#each h.detail.split('\n\n') as para}
            <p>{para}</p>
          {/each}
          {#if h.fix}
            <div class="fix">
              <div class="fixhead">
                <button class="ghost small" onclick={() => (openFix[key(h, i)] = !openFix[key(h, i)])}>{openFix[key(h, i)] ? '▾' : '▸'} Suggested SQL</button>
                <span class="grow"></span>
                <button class="small" onclick={() => copy(h.fix!)}>Copy</button>
              </div>
              {#if openFix[key(h, i)]}
                <pre>{h.fix}</pre>
                {#if h.fixNote}<div class="note muted">{h.fixNote}</div>{/if}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <div class="flowhead">
      <button class="ghost small" onclick={() => (showFlow = !showFlow)}>{showFlow ? '▾' : '▸'} Row flow</button>
      <span class="muted small">{plan.analyze ? 'actual rows' : 'estimated rows'} in and out of each step</span>
    </div>
    {#if showFlow}
      {#if flowRows.length === 0}
        <div class="pad muted small">Every step passed its rows through unchanged.</div>
      {:else}
        <div class="flow">
          {#each flowRows as s (s.node.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="step" class:late={s.late} class:focused={focused === s.node.id} onclick={() => onFocus(s.node.id)} role="button" tabindex="-1" title={s.late ? 'Rows were discarded here, after being joined' : ''}>
              <span class="sname">{#if s.late}<span class="flag">⚠</span>{/if}{nodeLabel(s.node)}</span>
              <span class="bars">
                <span class="b in" style="width: {bar(s.rowsIn)}%"></span>
                <span class="b out" style="width: {bar(s.rowsOut)}%"></span>
              </span>
              <span class="nums">{fmtNum(Math.round(s.rowsIn))} → {fmtNum(Math.round(s.rowsOut))}</span>
              <span class="kept" class:drop={s.kept < 0.1} class:grow-rows={s.kept > 1}>{s.kept > 1 ? `x${s.kept >= 10 ? Math.round(s.kept) : s.kept.toFixed(1)}` : pct(s.kept)}</span>
            </div>
          {/each}
        </div>
        <div class="legend muted small"><span class="b in"></span> rows in <span class="b out"></span> rows out · log scale · ⚠ filtered after a join</div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .panel { height: 100%; overflow: auto; background: var(--bg-2); font-size: 12.5px; display: flex; flex-direction: column; }
  .panel > * { flex-shrink: 0; }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg-2); z-index: 1; }
  .grow { flex: 1; }
  .small { font-size: 11.5px; }
  .pad { padding: 12px; line-height: 1.45; }
  .status { padding: 6px 10px; font-size: 11.5px; border-bottom: 1px solid var(--border); }
  .chip { font-size: 10.5px; padding: 1px 7px; border-radius: 9px; font-weight: 600; }
  .chip.high { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); }
  .chip.medium { background: color-mix(in srgb, var(--warn) 22%, transparent); color: var(--warn); }
  .chip.low { background: var(--bg-3); color: var(--fg-2); }
  .list { display: flex; flex-direction: column; }
  .hint { padding: 8px 10px 8px 12px; border-bottom: 1px solid var(--border); border-left: 3px solid var(--fg-3); }
  .hint.high { border-left-color: var(--danger); }
  .hint.medium { border-left-color: var(--warn); }
  .hint.focused { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .title { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
  .sev { font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
  .sev.high { color: var(--danger); }
  .sev.medium { color: var(--warn); }
  .sev.low { color: var(--fg-2); }
  .cat { font-size: 10px; color: var(--fg-2); background: var(--bg-3); padding: 0 5px; border-radius: 3px; }
  .ttext { font-weight: 600; flex-basis: 100%; }
  .node { background: transparent; border: none; color: var(--accent); padding: 0; font-family: var(--font-mono); font-size: 11.5px; text-align: left; cursor: pointer; margin-bottom: 4px; }
  .node:hover { text-decoration: underline; background: transparent; }
  p { margin: 4px 0; line-height: 1.45; color: var(--fg); }
  .fix { margin-top: 6px; }
  .fixhead { display: flex; align-items: center; gap: 6px; }
  pre { margin: 4px 0 0; padding: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; font-family: var(--font-mono); font-size: 11.5px; white-space: pre-wrap; word-break: break-word; user-select: text; }
  .note { margin-top: 4px; font-size: 11.5px; line-height: 1.4; }
  .flowhead { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border); margin-top: 4px; }
  .flow { display: flex; flex-direction: column; }
  .step { display: grid; grid-template-columns: minmax(120px, 1.2fr) minmax(60px, 1fr) max-content 44px; gap: 8px; align-items: center; padding: 3px 10px; border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent); cursor: pointer; }
  .step:hover { background: var(--bg-hover); }
  .step.focused { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .sname { font-family: var(--font-mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flag { color: var(--warn); margin-right: 4px; }
  .bars { display: flex; flex-direction: column; gap: 2px; }
  .b { display: inline-block; height: 5px; border-radius: 2px; }
  .b.in { background: var(--fg-3); }
  .b.out { background: var(--accent); }
  .nums { font-family: var(--font-mono); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .kept { font-family: var(--font-mono); font-size: 11px; text-align: right; color: var(--fg-2); }
  .kept.drop { color: var(--warn); }
  .kept.grow-rows { color: var(--syn-keyword); }
  .legend { padding: 6px 10px; display: flex; align-items: center; gap: 6px; }
  .legend .b { width: 14px; }
</style>
