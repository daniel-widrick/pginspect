<script lang="ts">
  // Draws a parsed plan as a tree diagram. The graph is built here from the
  // parsed nodes and laid out in Go by the diagram library, which measures
  // labels with the same Go Mono face the page loads.
  import { RenderDiagram } from '../../wailsjs/go/main/App'
  import { fmtMs, fmtNum, pct, detailEntries, type ParsedPlan, type PlanNode } from '../lib/plan'
  import { errorMessage } from '../lib/state.svelte'

  interface Props { plan: ParsedPlan; title: string; focus?: number | null }
  let { plan, title, focus = null }: Props = $props()

  let svg = $state('')
  let error = $state('')
  let zoom = $state(1)
  let direction = $state<'topdown' | 'leftright'>('topdown')
  /** Compact nodes show one line each; the default for sideways trees. */
  let compact = $state(false)
  let compactTouched = false
  /** Ids of nodes whose subtrees are folded away. */
  let collapsed = $state(new Set<number>())
  let autoFolded = $state(0)

  const LARGE = 100

  /** Folds the deepest levels until at most LARGE nodes remain visible. */
  function autoFold() {
    if (plan.nodes.length <= LARGE) { collapsed = new Set(); autoFolded = 0; return }
    const byDepth = new Map<number, number>()
    for (const n of plan.nodes) byDepth.set(n.depth, (byDepth.get(n.depth) ?? 0) + 1)
    let depth = 0, visible = 0
    for (; ; depth++) {
      const next = visible + (byDepth.get(depth) ?? 0)
      if (next > LARGE && depth > 0) break
      visible = next
      if (!byDepth.has(depth + 1)) { depth++; break }
    }
    const set = new Set<number>()
    for (const n of plan.nodes) if (n.depth === depth - 1 && n.children.length) set.add(n.id)
    collapsed = set
    autoFolded = plan.nodes.length - visible
  }

  function toggleFold(n: PlanNode) {
    const set = new Set(collapsed)
    if (set.has(n.id)) set.delete(n.id)
    else if (n.children.length) set.add(n.id)
    collapsed = set
  }

  function expandAll() { collapsed = new Set(); autoFolded = 0 }

  $effect(() => { plan; autoFold() })
  $effect(() => {
    // Sideways trees get very wide with full nodes; go compact unless the user chose.
    if (!compactTouched) compact = direction === 'leftright'
  })
  let selected = $state<PlanNode | null>(null)
  let host = $state<HTMLDivElement>()

  function share(n: PlanNode): number {
    if (plan.analyze) return plan.totalTime ? (n.exclTime ?? 0) / plan.totalTime : 0
    return plan.totalCost ? n.exclCost / plan.totalCost : 0
  }

  const rowsText = (n: number) => `${fmtNum(n)} row${n === 1 ? '' : 's'}`

  /** Edge weight from row count on a log scale: 1 row is thin, 1M rows is thick. */
  function weight(rows: number): number {
    return Math.min(1, Math.log10(Math.max(1, rows)) / 6)
  }

  function buildSpec() {
    const nodes: any[] = []
    const edges: any[] = []
    const walk = (n: PlanNode, parent: PlanNode | null) => {
      const f = share(n)
      const lines: { text: string; style: string }[][] = []
      const first = [{ text: n.type, style: 'title' }]
      if (n.detail) first.push({ text: ' ' + n.detail, style: 'muted' })
      if (compact) first.push({ text: ` · ${plan.analyze ? fmtMs(n.exclTime) : fmtNum(Math.round(n.exclCost))} · ${pct(f)}`, style: 'muted' })
      lines.push(first)
      if (!compact) {
        if (n.role) lines.push([{ text: n.role, style: 'muted' }])
        const filter = n.raw['Filter'] ?? n.raw['Index Cond'] ?? n.raw['Hash Cond'] ?? n.raw['Merge Cond'] ?? n.raw['Join Filter'] ?? n.raw['Recheck Cond']
        if (filter) lines.push([{ text: String(filter), style: 'detail' }])
        if (plan.analyze) {
          lines.push([{ text: `${fmtMs(n.exclTime)} · ${pct(f)} of time`, style: 'detail' }])
          lines.push([{ text: `est ${fmtNum(n.planRows)} · actual ${rowsText(n.actualRows ?? 0)}${n.loops > 1 ? ` × ${fmtNum(n.loops)}` : ''}`, style: 'detail' }])
        } else {
          lines.push([{ text: `cost ${fmtNum(Math.round(n.exclCost))} · ${pct(f)} of total`, style: 'detail' }])
          lines.push([{ text: `est ${rowsText(n.planRows)}`, style: 'detail' }])
        }
      }
      const kind = f >= 0.5 ? 'hot' : n.warnings.length ? 'warm' : ''
      nodes.push({ id: String(n.id), kind, bar: f, maxWidth: compact ? 220 : 260, overflow: 'ellipsize', lines, collapsed: collapsed.has(n.id) })
      if (parent) {
        const rows = n.actualRows !== null ? n.actualRows * n.loops : n.planRows
        edges.push({
          from: String(parent.id), to: String(n.id), arrow: 'backward', weight: weight(rows),
          label: n.actualRows !== null ? `${rowsText(n.actualRows)}${n.loops > 1 ? ` × ${fmtNum(n.loops)}` : ''}` : rowsText(n.planRows),
        })
      }
      n.children.forEach(c => walk(c, n))
    }
    walk(plan.root, null)
    return { direction, nodes, edges, rankSep: direction === 'leftright' ? 40 : 34, nodeSep: compact ? 12 : 20 }
  }

  $effect(() => {
    const spec = buildSpec()
    selected = null
    RenderDiagram(spec as any, 'tree', title).then(s => { svg = s; error = '' }).catch(e => { error = errorMessage(e) })
  })

  // A hint asked for a node: unfold whatever hides it, select it, scroll to it.
  let pendingFocus = $state<number | null>(null)
  $effect(() => {
    if (focus === null) return
    const target = plan.nodes.find(n => n.id === focus)
    if (!target) return
    const hidden = new Set<number>()
    const walk = (n: PlanNode, folded: boolean) => {
      if (folded) hidden.add(n.id)
      n.children.forEach(c => walk(c, folded || collapsed.has(n.id)))
    }
    walk(plan.root, false)
    if (hidden.has(target.id)) {
      const set = new Set(collapsed)
      const unfold = (n: PlanNode, trail: PlanNode[]): boolean => {
        if (n.id === target.id) { trail.forEach(t => set.delete(t.id)); return true }
        return n.children.some(c => unfold(c, [...trail, n]))
      }
      unfold(plan.root, [])
      collapsed = set
    }
    pendingFocus = target.id
  })
  $effect(() => {
    if (pendingFocus === null || !host || !svg) return
    const g = host.querySelector(`g.node[data-id="${pendingFocus}"]`)
    if (!g) return
    selected = plan.nodes.find(n => n.id === pendingFocus) ?? null
    pendingFocus = null
    g.scrollIntoView({ block: 'center', inline: 'center' })
  })

  function nodeAt(e: MouseEvent): PlanNode | null {
    const g = (e.target as Element).closest('g.node[data-id]') as SVGGElement | null
    if (!g) return null
    const id = Number(g.dataset.id)
    return plan.nodes.find(n => n.id === id) ?? null
  }

  function onClick(e: MouseEvent) {
    if (dragged) { dragged = false; return }
    selected = nodeAt(e)
  }

  function onDblClick(e: MouseEvent) {
    const n = nodeAt(e)
    if (n) toggleFold(n)
  }

  // Drag anywhere on the canvas to pan the scroll container.
  let scrollEl = $state<HTMLDivElement>()
  let dragging = false
  let dragged = false
  let dragStart = { x: 0, y: 0, left: 0, top: 0 }
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || !scrollEl) return
    dragging = true
    dragged = false
    dragStart = { x: e.clientX, y: e.clientY, left: scrollEl.scrollLeft, top: scrollEl.scrollTop }
    scrollEl.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging || !scrollEl) return
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y
    if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true
    scrollEl.scrollLeft = dragStart.left - dx
    scrollEl.scrollTop = dragStart.top - dy
  }
  function onPointerUp() { dragging = false }

  // Highlight the selected node without re-rendering the SVG.
  $effect(() => {
    if (!host) return
    for (const g of host.querySelectorAll('g.node')) g.classList.toggle('selected', selected !== null && g.getAttribute('data-id') === String(selected.id))
  })

  function fit() {
    if (!host) return
    const svgEl = host.querySelector('svg')
    if (!svgEl) return
    const vb = svgEl.viewBox.baseVal
    const avail = host.parentElement!.clientWidth - 24
    zoom = Math.min(1, avail / vb.width)
  }
</script>

<div class="diagram">
  <div class="tools">
    <button class="small" onclick={() => (zoom = Math.min(3, zoom * 1.25))} title="Zoom in">+</button>
    <button class="small" onclick={() => (zoom = Math.max(0.2, zoom / 1.25))} title="Zoom out">−</button>
    <button class="small" onclick={() => (zoom = 1)} title="Actual size">1:1</button>
    <button class="small" onclick={fit} title="Fit width">Fit</button>
    <span class="sep"></span>
    <button class="small" class:active={direction === 'topdown'} onclick={() => (direction = 'topdown')} title="Root at the top">↓</button>
    <button class="small" class:active={direction === 'leftright'} onclick={() => (direction = 'leftright')} title="Root at the left">→</button>
    <button class="small" class:active={compact} onclick={() => { compactTouched = true; compact = !compact }} title="One line per node">Compact</button>
    {#if collapsed.size}
      <span class="sep"></span>
      <span class="muted small">{collapsed.size} folded{autoFolded ? ` (${autoFolded} nodes hidden automatically, plan has ${plan.nodes.length})` : ''}</span>
      <button class="small" onclick={expandAll}>Expand all</button>
    {/if}
    <span class="muted small">{Math.round(zoom * 100)}% · click for details · double-click to fold · drag to pan</span>
  </div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scroll" bind:this={scrollEl} onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}>
    {#if error}
      <div class="error-text pad">{error}</div>
    {:else if !svg}
      <div class="muted pad">Laying out...</div>
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="canvas" bind:this={host} style="transform: scale({zoom})" onclick={onClick} ondblclick={onDblClick}>{@html svg}</div>
    {/if}
  </div>
  {#if selected}
    <div class="details">
      <div class="dhead"><b>{selected.type}</b> <span class="muted">{selected.detail}</span>
        {#if selected.children.length}
          <button class="small fold" onclick={() => toggleFold(selected!)}>{collapsed.has(selected.id) ? `Unfold ${selected.children.length} child${selected.children.length === 1 ? '' : 'ren'}` : 'Fold subtree'}</button>
        {/if}
      </div>
      <div class="grid">
        {#if plan.analyze}
          <div><span class="k">Self time</span><span class="v">{fmtMs(selected.exclTime)} ({pct(share(selected))})</span></div>
          <div><span class="k">Inclusive time</span><span class="v">{fmtMs(selected.inclTime)}</span></div>
        {/if}
        <div><span class="k">Cost</span><span class="v">{selected.raw['Startup Cost']}..{selected.raw['Total Cost']}</span></div>
        {#each detailEntries(selected.raw) as [k, v]}
          <div><span class="k">{k}</span><span class="v">{v}</span></div>
        {/each}
      </div>
      {#if selected.warnings.length}
        <ul class="warn">{#each selected.warnings as w}<li>{w}</li>{/each}</ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .diagram { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .tools { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--bg-2); flex-shrink: 0; }
  .small { font-size: 11.5px; }
  .sep { width: 1px; height: 14px; background: var(--border); margin: 0 4px; }
  button.active { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .scroll { flex: 1; overflow: auto; min-height: 0; padding: 12px; cursor: grab; user-select: none; }
  .scroll:active { cursor: grabbing; }
  .pad { padding: 8px; }
  .canvas { transform-origin: top left; display: inline-block; font-family: "Go Mono", ui-monospace, Menlo, monospace; }
  .canvas :global(svg) { display: block; }
  .canvas :global(g.node) { cursor: pointer; }
  .canvas :global(g.node:hover rect:first-child) { stroke: var(--accent); stroke-width: 1.5; }
  .canvas :global(g.node.selected rect:first-child) { stroke: var(--accent); stroke-width: 2; }
  .details { border-top: 1px solid var(--border); background: var(--bg-2); padding: 8px 12px; max-height: 40%; overflow: auto; font-size: 12px; flex-shrink: 0; }
  .dhead { margin-bottom: 6px; display: flex; align-items: center; gap: 10px; }
  .fold { margin-left: auto; }
  .grid { display: grid; grid-template-columns: max-content 1fr; column-gap: 14px; row-gap: 2px; }
  .grid > div { display: contents; }
  .k { color: var(--fg-2); }
  .v { font-family: var(--font-mono); white-space: pre-wrap; word-break: break-word; }
  .warn { margin: 8px 0 0; padding-left: 18px; color: var(--warn); }
</style>
