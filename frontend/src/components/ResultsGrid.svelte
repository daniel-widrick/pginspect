<script lang="ts">
  import type { db } from '../../wailsjs/go/models'
  import { ClipboardSetText } from '../../wailsjs/runtime/runtime'
  import { ExportCSV } from '../../wailsjs/go/main/App'
  import { errorMessage, toast, type QueryTab } from '../lib/state.svelte'

  interface Props { tab: QueryTab }
  let { tab }: Props = $props()

  const numericTypes = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'oid', 'money'])

  let sortCol = $state(-1)
  let sortDir = $state<1 | -1>(1)
  let selected = $state<{ r: number; c: number } | null>(null)
  let gridEl = $state<HTMLDivElement>()

  const result = $derived<db.Result | undefined>(tab.response?.results[tab.activeResult])

  // Reset view state when a new response arrives.
  $effect(() => {
    tab.response
    sortCol = -1
    selected = null
  })

  const rows = $derived.by(() => {
    if (!result) return []
    const indexed = result.rows.map((row, i) => ({ row, i }))
    if (sortCol < 0) return indexed
    const numeric = numericTypes.has(result.columns[sortCol]?.type)
    const cmp = (a: string | null, b: string | null) => {
      if (a === null) return b === null ? 0 : 1
      if (b === null) return -1
      if (numeric) return Number(a) - Number(b)
      return a < b ? -1 : a > b ? 1 : 0
    }
    return [...indexed].sort((x, y) => sortDir * cmp(x.row[sortCol] as any, y.row[sortCol] as any))
  })

  function toggleSort(c: number) {
    if (sortCol === c) {
      if (sortDir === 1) sortDir = -1
      else { sortCol = -1; sortDir = 1 }
    } else { sortCol = c; sortDir = 1 }
  }

  function cellText(v: string | null | undefined): string {
    return v === null || v === undefined ? '' : v
  }

  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'c' && selected && result) {
      const v = rows[selected.r]?.row[selected.c]
      void ClipboardSetText(cellText(v as any))
      e.preventDefault()
      return
    }
    if (!selected || !result) return
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
    }
    const m = moves[e.key]
    if (!m) return
    e.preventDefault()
    selected = {
      r: Math.max(0, Math.min(rows.length - 1, selected.r + m[0])),
      c: Math.max(0, Math.min(result.columns.length - 1, selected.c + m[1])),
    }
    gridEl?.querySelector<HTMLElement>(`td[data-r="${selected.r}"][data-c="${selected.c}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  export async function exportCsv() {
    if (!result || !result.columns.length) { toast('Nothing to export'); return }
    try {
      const ordered = rows.map(r => r.row)
      const path = await ExportCSV(result.columns.map(c => c.name), ordered, `${tab.title.replace(/[^\w.-]+/g, '_')}.csv`)
      if (path) toast(`Exported ${ordered.length} rows to ${path}`)
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 6000)
    }
  }

  function copyRowAsText(r: number) {
    if (!result) return
    const row = rows[r].row.map(v => cellText(v as any)).join('\t')
    void ClipboardSetText(row)
    toast('Row copied')
  }
</script>

<div class="results">
  {#if tab.running}
    <div class="empty"><span class="spinner"></span> Running...</div>
  {:else if !tab.response}
    <div class="empty muted">Run a query to see results here.</div>
  {:else}
    {#if tab.response.results.length > 1}
      <div class="result-tabs">
        {#each tab.response.results as r, i}
          <button class:active={i === tab.activeResult} onclick={() => (tab.activeResult = i)}>
            {i + 1}. {r.columns?.length ? `${r.rowCount} rows` : r.command || 'ok'}
          </button>
        {/each}
      </div>
    {/if}

    {#if tab.response.error}
      <div class="error-box">
        <div class="error-text">{tab.response.cancelled ? 'Query cancelled.' : tab.response.error}</div>
      </div>
    {/if}

    {#if result && result.columns?.length}
      <div class="grid" bind:this={gridEl} tabindex="0" onkeydown={onKeydown} role="grid">
        <table>
          <thead>
            <tr>
              <th class="rownum"></th>
              {#each result.columns as col, c}
                <th onclick={() => toggleSort(c)} title="{col.type} (click to sort)">
                  <span class="colname">{col.name}</span>
                  <span class="coltype">{col.type}</span>
                  {#if sortCol === c}<span class="sort">{sortDir === 1 ? '▲' : '▼'}</span>{/if}
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each rows as { row, i }, r (i)}
              <tr>
                <td class="rownum" ondblclick={() => copyRowAsText(r)} title="Double-click to copy row">{i + 1}</td>
                {#each row as v, c}
                  <td
                    data-r={r} data-c={c}
                    class:null={v === null}
                    class:selected={selected?.r === r && selected?.c === c}
                    class:num={numericTypes.has(result.columns[c]?.type)}
                    onclick={() => (selected = { r, c })}
                    ondblclick={() => { void ClipboardSetText(cellText(v as any)); toast('Copied') }}
                  >{v === null ? 'NULL' : v}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if result && !tab.response.error}
      <div class="empty">
        <span class="mono">{result.command || 'OK'}</span>
        {#if result.rowsAffected > 0}<span class="muted">, {result.rowsAffected} row{result.rowsAffected === 1 ? '' : 's'} affected</span>{/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .results { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); }
  .empty { padding: 16px; display: flex; gap: 8px; align-items: center; }
  .result-tabs { display: flex; gap: 2px; padding: 4px 6px 0; border-bottom: 1px solid var(--border); background: var(--bg-2); flex-shrink: 0; }
  .result-tabs button { border: none; border-radius: 4px 4px 0 0; background: transparent; padding: 3px 10px; font-size: 12px; color: var(--fg-2); }
  .result-tabs button.active { background: var(--bg); color: var(--fg); box-shadow: inset 0 -2px 0 var(--accent); }
  .error-box { padding: 10px 14px; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--danger) 8%, var(--bg)); flex-shrink: 0; max-height: 40%; overflow: auto; }
  .grid { flex: 1; overflow: auto; outline: none; min-height: 0; }
  table { border-collapse: separate; border-spacing: 0; font-family: var(--font-mono); font-size: 12px; min-width: 100%; }
  th, td { padding: 3px 10px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); white-space: pre; max-width: 480px; overflow: hidden; text-overflow: ellipsis; text-align: left; }
  th { position: sticky; top: 0; background: var(--bg-2); font-weight: 600; cursor: pointer; user-select: none; z-index: 1; }
  th:hover { background: var(--bg-hover); }
  .colname { display: block; }
  .coltype { display: block; font-weight: 400; color: var(--fg-3); font-size: 10px; }
  .sort { color: var(--accent); font-size: 9px; margin-left: 4px; }
  td.rownum, th.rownum { position: sticky; left: 0; background: var(--bg-2); color: var(--fg-3); text-align: right; user-select: none; z-index: 1; min-width: 40px; cursor: default; }
  th.rownum { z-index: 2; }
  td.null { color: var(--null); font-style: italic; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.selected { background: var(--selection) !important; outline: 1px solid var(--accent); outline-offset: -1px; }
  tbody tr:nth-child(even) td { background: var(--row-alt); }
  tbody tr:nth-child(even) td.rownum { background: var(--bg-2); }
  tbody tr:hover td { background: var(--bg-hover); }
  .spinner { width: 12px; height: 12px; border: 2px solid var(--fg-3); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
