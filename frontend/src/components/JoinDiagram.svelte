<script lang="ts">
  // The relationship view: the tables a plan touches, how each was reached,
  // and the join conditions between them, drawn as a layered graph.
  import { RenderDiagram } from '../../wailsjs/go/main/App'
  import { fmtMs, fmtNum, pct, type ParsedPlan, type PlanNode } from '../lib/plan'
  import { errorMessage } from '../lib/state.svelte'

  interface Props { plan: ParsedPlan }
  let { plan }: Props = $props()

  let svg = $state('')
  let error = $state('')
  let zoom = $state(1)
  let direction = $state<'leftright' | 'topdown'>('leftright')
  let host = $state<HTMLDivElement>()
  let notes = $state<string[]>([])

  const scanTypes = new Set(['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan', 'Tid Scan', 'Tid Range Scan', 'Foreign Scan', 'CTE Scan', 'Function Scan', 'Values Scan', 'Subquery Scan', 'Sample Scan', 'Table Function Scan', 'WorkTable Scan'])
  const joinTypes = new Set(['Nested Loop', 'Hash Join', 'Merge Join'])

  function share(n: PlanNode): number {
    if (plan.analyze) return plan.totalTime ? (n.exclTime ?? 0) / plan.totalTime : 0
    return plan.totalCost ? n.exclCost / plan.totalCost : 0
  }

  interface Table { id: string; node: PlanNode; alias: string; name: string }

  /** Every scan in the plan, keyed by alias (or relation name when unaliased). */
  function tables(): Table[] {
    const out: Table[] = []
    for (const n of plan.nodes) {
      if (!scanTypes.has(n.type)) continue
      const name = n.raw['Relation Name'] ?? n.raw['CTE Name'] ?? n.raw['Function Name'] ?? n.raw['Alias'] ?? n.type
      const alias = n.raw['Alias'] ?? name
      out.push({ id: `t${n.id}`, node: n, alias, name })
    }
    return out
  }

  /** Scans below a plan node. */
  function scansUnder(n: PlanNode, ts: Table[]): Table[] {
    const ids = new Set<number>()
    const walk = (m: PlanNode) => { ids.add(m.id); m.children.forEach(walk) }
    walk(n)
    return ts.filter(t => ids.has(t.node.id))
  }

  /** Pulls alias.column = alias.column pairs out of a condition. */
  function pairs(cond: string): [string, string][] {
    const out: [string, string][] = []
    for (const m of cond.matchAll(/([A-Za-z_][\w$]*)\.[A-Za-z_][\w$]*\s*=\s*([A-Za-z_][\w$]*)\.[A-Za-z_][\w$]*/g)) {
      if (m[1] !== m[2]) out.push([m[1], m[2]])
    }
    return out
  }

  /** column = literal predicates in a condition, e.g. (product_id = 42). */
  function constants(cond: string): { col: string; lit: string }[] {
    const out: { col: string; lit: string }[] = []
    for (const m of cond.matchAll(/([A-Za-z_][\w$.]*)\s*=\s*('(?:[^']|'')*'(?:::[\w ]+)?|-?\d+(?:\.\d+)?(?:::[\w ]+)?)/g)) {
      out.push({ col: m[1], lit: m[2].replace(/::[\w ]+$/, '') })
    }
    return out
  }

  /** All conditions on a scan node (index, recheck, filter). */
  function scanConds(n: PlanNode): string[] {
    return ['Index Cond', 'Recheck Cond', 'Filter'].map(k => n.raw[k]).filter(Boolean).map(String)
  }

  /**
   * When the planner folds a join key to a constant on both sides
   * (where c.id = 1 turns o.customer_id = c.id into o.customer_id = 1), no
   * alias pair survives. Two scans filtering different columns on the same
   * literal almost always mean that join, so report it as such.
   */
  function foldedJoin(left: Table[], right: Table[]): { a: Table; b: Table; text: string } | null {
    for (const ta of left) {
      for (const ca of scanConds(ta.node).flatMap(constants)) {
        for (const tb of right) {
          for (const cb of scanConds(tb.node).flatMap(constants)) {
            if (ca.lit === cb.lit && ta !== tb) {
              return { a: ta, b: tb, text: `${ta.alias}.${ca.col.replace(/^.*\./, '')} = ${tb.alias}.${cb.col.replace(/^.*\./, '')} (both = ${ca.lit})` }
            }
          }
        }
      }
    }
    return null
  }

  function buildSpec() {
    const ts = tables()
    const byAlias = new Map(ts.map(t => [t.alias, t]))
    const nodes = ts.map(t => {
      const n = t.node
      const f = share(n)
      const how = n.raw['Index Name'] ? `${n.type} · ${n.raw['Index Name']}` : n.type
      const rows = n.actualRows !== null ? `${fmtNum(n.actualRows * n.loops)} rows` : `est ${fmtNum(n.planRows)} rows`
      const lines: { text: string; style: string }[][] = [
        [{ text: t.name, style: 'title' }, ...(t.alias !== t.name ? [{ text: ` ${t.alias}`, style: 'muted' }] : [])],
        [{ text: how, style: 'detail' }],
        [{ text: `${rows}${plan.analyze ? ` · ${fmtMs(n.exclTime)} · ${pct(f)}` : ` · ${pct(f)} of cost`}`, style: 'muted' }],
      ]
      if (n.raw['Filter']) lines.push([{ text: `filter ${n.raw['Filter']}`, style: 'detail' }])
      return { id: t.id, kind: f >= 0.5 ? 'hot' : n.warnings.length ? 'warm' : '', bar: f, maxWidth: 280, overflow: 'ellipsize', lines }
    })
    const edges: any[] = []
    const seen = new Set<string>()
    const newNotes: string[] = []
    for (const j of plan.nodes) {
      if (!joinTypes.has(j.type)) continue
      const conds: string[] = []
      for (const k of ['Hash Cond', 'Merge Cond', 'Join Filter']) if (j.raw[k]) conds.push(String(j.raw[k]))
      // Nested loops push the condition into the inner scan's Index Cond or Filter.
      if (j.children[1]) {
        const inner = j.children[1]
        const walk = (m: PlanNode) => {
          for (const k of ['Index Cond', 'Recheck Cond', 'Filter']) if (m.raw[k] && pairs(String(m.raw[k])).length) conds.push(String(m.raw[k]))
          m.children.forEach(walk)
        }
        walk(inner)
      }
      const left = scansUnder(j.children[0], ts)
      const right = j.children[1] ? scansUnder(j.children[1], ts) : []
      let added = 0
      for (const cond of conds) {
        for (const [a, b] of pairs(cond)) {
          const ta = byAlias.get(a), tb = byAlias.get(b)
          if (!ta || !tb) continue
          const key = [ta.id, tb.id].sort().join('|') + cond
          if (seen.has(key)) continue
          seen.add(key)
          const innerSeq = [ta, tb].some(t => t.node.type === 'Seq Scan' && share(t.node) >= 0.2)
          edges.push({ from: ta.id, to: tb.id, label: `${j.type.replace(' Join', '').toLowerCase()} · ${cond}`, arrow: 'none', kind: innerSeq ? 'weak' : '' })
          added++
        }
      }
      if (added === 0 && left.length && right.length) {
        const folded = foldedJoin(left, right)
        if (folded) {
          const key = [folded.a.id, folded.b.id].sort().join('|') + folded.text
          if (!seen.has(key)) {
            seen.add(key)
            const innerSeq = [folded.a, folded.b].some(t => t.node.type === 'Seq Scan' && share(t.node) >= 0.2)
            edges.push({ from: folded.a.id, to: folded.b.id, label: `${j.type.replace(' Join', '').toLowerCase()} · ${folded.text}`, arrow: 'none', kind: innerSeq ? 'weak' : '' })
          }
        } else {
          edges.push({ from: left[0].id, to: right[0].id, label: `${j.type} · no join condition`, arrow: 'none', kind: 'weak' })
          newNotes.push(`${j.type} without a usable equality condition between ${left[0].alias} and ${right[0].alias}`)
        }
      }
    }
    notes = newNotes
    return { direction, routing: 'orthogonal', nodes, edges, rankSep: 48, nodeSep: 24 }
  }

  $effect(() => {
    const spec = buildSpec()
    if (spec.nodes.length === 0) { svg = ''; error = 'No table scans in this plan.'; return }
    RenderDiagram(spec as any, 'layered', 'Tables and joins').then(s => { svg = s; error = '' }).catch(e => { error = errorMessage(e) })
  })

  function fit() {
    const svgEl = host?.querySelector('svg')
    if (!svgEl || !host) return
    const vb = svgEl.viewBox.baseVal
    zoom = Math.min(1, (host.parentElement!.clientWidth - 24) / vb.width)
  }
</script>

<div class="joins">
  <div class="tools">
    <button class="small" onclick={() => (zoom = Math.min(3, zoom * 1.25))} title="Zoom in">+</button>
    <button class="small" onclick={() => (zoom = Math.max(0.2, zoom / 1.25))} title="Zoom out">−</button>
    <button class="small" onclick={() => (zoom = 1)} title="Actual size">1:1</button>
    <button class="small" onclick={fit} title="Fit width">Fit</button>
    <span class="sep"></span>
    <button class="small" class:active={direction === 'leftright'} onclick={() => (direction = 'leftright')} title="Flow left to right">→</button>
    <button class="small" class:active={direction === 'topdown'} onclick={() => (direction = 'topdown')} title="Flow top to bottom">↓</button>
    <span class="muted small">Tables the plan touched and the conditions joining them. Dashed edges join into a costly sequential scan.</span>
  </div>
  <div class="scroll">
    {#if error}
      <div class="muted pad">{error}</div>
    {:else if !svg}
      <div class="muted pad">Laying out...</div>
    {:else}
      <div class="canvas" bind:this={host} style="transform: scale({zoom})">{@html svg}</div>
    {/if}
    {#if notes.length}
      <ul class="notes">{#each notes as n}<li>{n}</li>{/each}</ul>
    {/if}
  </div>
</div>

<style>
  .joins { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .tools { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--bg-2); flex-shrink: 0; flex-wrap: wrap; }
  .small { font-size: 11.5px; }
  .sep { width: 1px; height: 14px; background: var(--border); margin: 0 4px; }
  button.active { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .scroll { flex: 1; overflow: auto; min-height: 0; padding: 12px; }
  .pad { padding: 8px; }
  .canvas { transform-origin: top left; display: inline-block; font-family: "Go Mono", ui-monospace, Menlo, monospace; }
  .canvas :global(svg) { display: block; }
  .notes { margin: 10px 0 0; padding-left: 18px; color: var(--warn); font-size: 12px; }
</style>
