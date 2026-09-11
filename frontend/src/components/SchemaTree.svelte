<script lang="ts">
  import { ListSchemas, ListRelations, ListFunctions, ListColumns, FunctionDefinition } from '../../wailsjs/go/main/App'
  import type { db } from '../../wailsjs/go/models'
  import { store, errorMessage, toast } from '../lib/state.svelte'
  import { newQueryTab, runQuery, openStructureTab } from '../lib/tabs.svelte'

  interface Props { connId: string }
  let { connId }: Props = $props()

  let schemas = $state<db.Schema[]>([])
  let relations = $state<Record<string, db.Relation[]>>({})
  let routines = $state<Record<string, db.Routine[]>>({})
  let columns = $state<Record<string, db.ColumnInfo[]>>({})
  let open = $state<Record<string, boolean>>({})
  let loading = $state<Record<string, boolean>>({})
  let error = $state('')
  let filter = $state('')

  const q = (s: string) => '"' + s.replace(/"/g, '""') + '"'
  const qn = (s: string, n: string) => `${q(s)}.${q(n)}`

  export async function refresh() {
    error = ''
    try {
      schemas = await ListSchemas(connId)
      relations = {}; routines = {}; columns = {}
      // Re-load anything that was expanded.
      for (const s of schemas) {
        if (open[`t:${s.name}`]) void loadRelations(s.name)
        if (open[`f:${s.name}`]) void loadRoutines(s.name)
      }
      if (schemas.length === 1) open[`s:${schemas[0].name}`] = true
      if (!schemas.some(s => open[`s:${s.name}`])) {
        const pub = schemas.find(s => s.name === 'public') ?? schemas[0]
        if (pub) { open[`s:${pub.name}`] = true; open[`t:${pub.name}`] = true; void loadRelations(pub.name) }
      }
    } catch (e) {
      error = errorMessage(e)
    }
  }

  $effect(() => { connId; void refresh() })

  function toggle(key: string, loader?: () => Promise<void>) {
    open[key] = !open[key]
    if (open[key] && loader) void loader()
  }

  async function loadRelations(schema: string) {
    if (relations[schema]) return
    loading[`t:${schema}`] = true
    try {
      relations[schema] = await ListRelations(connId, schema)
      if (!store.schemas[connId]) store.schemas[connId] = {}
      if (!store.schemas[connId][schema]) store.schemas[connId][schema] = {}
      const tables = store.schemas[connId][schema]
      for (const r of relations[schema]) if (!tables[r.name]) tables[r.name] = []
    } catch (e) { toast(errorMessage(e)) } finally { loading[`t:${schema}`] = false }
  }

  async function loadRoutines(schema: string) {
    if (routines[schema]) return
    loading[`f:${schema}`] = true
    try { routines[schema] = await ListFunctions(connId, schema) }
    catch (e) { toast(errorMessage(e)) } finally { loading[`f:${schema}`] = false }
  }

  async function loadColumns(rel: db.Relation) {
    const key = `${rel.schema}.${rel.name}`
    if (columns[key]) return
    loading[`r:${key}`] = true
    try {
      columns[key] = await ListColumns(connId, rel.schema, rel.name)
      if (!store.schemas[connId]) store.schemas[connId] = {}
      if (!store.schemas[connId][rel.schema]) store.schemas[connId][rel.schema] = {}
      store.schemas[connId][rel.schema][rel.name] = columns[key].map(c => c.name)
    } catch (e) { toast(errorMessage(e)) } finally { loading[`r:${key}`] = false }
  }

  function openData(rel: db.Relation) {
    const sql = `select *\nfrom ${qn(rel.schema, rel.name)}\nlimit 200;`
    const tab = newQueryTab(connId, sql, `${rel.name}`)
    void runQuery(tab, sql)
  }

  async function openRoutine(fn: db.Routine) {
    try {
      const def = await FunctionDefinition(connId, fn.oid)
      newQueryTab(connId, def, `${fn.name}()`)
    } catch (e) { toast(errorMessage(e)) }
  }

  const kindGlyph: Record<string, string> = { table: 'T', partitioned: 'P', view: 'V', matview: 'M', foreign: 'F' }

  function matches(name: string) {
    return !filter || name.toLowerCase().includes(filter.toLowerCase())
  }
</script>

<div class="tree">
  <div class="toolbar">
    <input type="text" placeholder="Filter objects" bind:value={filter} />
    <button class="ghost small" title="Refresh" onclick={refresh}>↻</button>
  </div>
  {#if error}<div class="error-text pad">{error}</div>{/if}
  {#each schemas as s (s.name)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
    <div class="node" onclick={() => toggle(`s:${s.name}`)} role="button" tabindex="-1">
      <span class="caret">{open[`s:${s.name}`] ? '▾' : '▸'}</span>
      <span class="glyph schema">S</span>
      <span class="label" title={s.comment}>{s.name}</span>
    </div>
    {#if open[`s:${s.name}`]}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
      <div class="node lvl1" onclick={() => toggle(`t:${s.name}`, () => loadRelations(s.name))} role="button" tabindex="-1">
        <span class="caret">{open[`t:${s.name}`] ? '▾' : '▸'}</span>
        <span class="label">Tables &amp; views</span>
        {#if relations[s.name]}<span class="count">{relations[s.name].length}</span>{/if}
        {#if loading[`t:${s.name}`]}<span class="count">...</span>{/if}
      </div>
      {#if open[`t:${s.name}`]}
        {#each (relations[s.name] ?? []).filter(r => matches(r.name)) as rel (rel.name)}
          {@const key = `${rel.schema}.${rel.name}`}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
          <div class="node lvl2 rel" role="button" tabindex="-1"
               onclick={() => toggle(`r:${key}`, () => loadColumns(rel))}
               ondblclick={() => openData(rel)}>
            <span class="caret">{open[`r:${key}`] ? '▾' : '▸'}</span>
            <span class="glyph {rel.kind}">{kindGlyph[rel.kind] ?? '?'}</span>
            <span class="label" title="{rel.kind}{rel.comment ? ': ' + rel.comment : ''}">{rel.name}</span>
            <span class="actions">
              <button class="ghost small" title="Query data" onclick={(e) => { e.stopPropagation(); openData(rel) }}>▶</button>
              <button class="ghost small" title="Structure and DDL" onclick={(e) => { e.stopPropagation(); void openStructureTab(connId, rel.schema, rel.name) }}>≡</button>
            </span>
          </div>
          {#if open[`r:${key}`]}
            {#each columns[key] ?? [] as col (col.name)}
              <div class="node lvl3 col" title="{col.type}{col.notNull ? ' not null' : ''}{col.default ? ' default ' + col.default : ''}">
                <span class="glyph col" class:pk={col.primaryKey}>{col.primaryKey ? '🔑' : '·'}</span>
                <span class="label">{col.name}</span>
                <span class="type">{col.type}</span>
              </div>
            {/each}
            {#if loading[`r:${key}`]}<div class="node lvl3 muted">loading...</div>{/if}
          {/if}
        {/each}
      {/if}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
      <div class="node lvl1" onclick={() => toggle(`f:${s.name}`, () => loadRoutines(s.name))} role="button" tabindex="-1">
        <span class="caret">{open[`f:${s.name}`] ? '▾' : '▸'}</span>
        <span class="label">Functions</span>
        {#if routines[s.name]}<span class="count">{routines[s.name].length}</span>{/if}
        {#if loading[`f:${s.name}`]}<span class="count">...</span>{/if}
      </div>
      {#if open[`f:${s.name}`]}
        {#each (routines[s.name] ?? []).filter(f => matches(f.name)) as fn (fn.oid)}
          <div class="node lvl2 rel" role="button" tabindex="-1" ondblclick={() => openRoutine(fn)}
               title="{fn.kind} {fn.name}({fn.arguments}) returns {fn.returns}">
            <span class="caret"></span>
            <span class="glyph fn">fx</span>
            <span class="label">{fn.name}<span class="args">({fn.arguments})</span></span>
            <span class="actions">
              <button class="ghost small" title="Open definition" onclick={(e) => { e.stopPropagation(); void openRoutine(fn) }}>≡</button>
            </span>
          </div>
        {/each}
      {/if}
    {/if}
  {/each}
</div>

<style>
  .tree { font-size: 12.5px; padding-bottom: 8px; }
  .toolbar { display: flex; gap: 4px; padding: 6px 8px; }
  .toolbar input { padding: 3px 8px; font-size: 12px; }
  .pad { padding: 6px 10px; }
  .node { display: flex; align-items: center; gap: 4px; padding: 2px 8px; cursor: default; white-space: nowrap; user-select: none; min-height: 22px; }
  .node:hover { background: var(--bg-hover); }
  .lvl1 { padding-left: 24px; }
  .lvl2 { padding-left: 40px; }
  .lvl3 { padding-left: 62px; }
  .caret { width: 12px; color: var(--fg-3); font-size: 10px; flex-shrink: 0; }
  .label { overflow: hidden; text-overflow: ellipsis; }
  .count, .type { color: var(--fg-3); font-size: 11px; margin-left: auto; padding-left: 8px; }
  .type { font-family: var(--font-mono); }
  .args { color: var(--fg-3); font-size: 11px; }
  .glyph { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 3px; font-size: 9px; font-weight: 700; flex-shrink: 0; background: var(--bg-3); color: var(--fg-2); }
  .glyph.schema { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); }
  .glyph.table, .glyph.partitioned { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .glyph.view, .glyph.matview { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  .glyph.foreign { background: color-mix(in srgb, var(--danger) 20%, transparent); color: var(--danger); }
  .glyph.fn { background: color-mix(in srgb, var(--syn-keyword) 20%, transparent); color: var(--syn-keyword); font-style: italic; }
  .glyph.col { background: transparent; font-size: 10px; }
  .actions { margin-left: auto; display: none; gap: 2px; }
  .rel:hover .actions { display: inline-flex; }
  .rel:hover .count { display: none; }
  .actions button { padding: 0 5px; font-size: 11px; line-height: 16px; }
</style>
