<script lang="ts">
  import { store, serverMajor } from '../lib/state.svelte'
  import { newQueryTab, explainQuery, substituteParams } from '../lib/tabs.svelte'

  interface Props { request: { connId: string; sql: string; params: number[]; title: string } }
  let { request }: Props = $props()

  const canGeneric = $derived(serverMajor(request.connId) >= 16)
  let values = $state<Record<number, string>>({})
  let first = $state<HTMLInputElement>()

  $effect(() => { first?.focus() })

  const missing = $derived(request.params.filter(n => !(values[n] ?? '').trim()))
  const preview = $derived(substituteParams(request.sql, values))

  function close() { store.dialog = null }

  // Copy what we need before closing: the prop reads through to store.dialog,
  // which close() sets to null.
  function explainWithValues(e: Event) {
    e.preventDefault()
    if (missing.length) return
    const { connId, title } = request
    const sql = preview.trim()
    close()
    const tab = newQueryTab(connId, sql + '\n', title)
    void explainQuery(tab, sql, false)
  }

  function explainGeneric() {
    const { connId, title } = request
    const sql = request.sql.trim()
    close()
    const tab = newQueryTab(connId, sql + '\n', title)
    void explainQuery(tab, sql, false, true)
  }
</script>

<div class="backdrop" onclick={close} onkeydown={(e) => e.key === 'Escape' && close()} role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <form class="dialog" onclick={(e) => e.stopPropagation()} onsubmit={explainWithValues}>
    <h2>Explain a parameterised statement</h2>
    <p class="muted">
      pg_stat_statements replaces constants with placeholders. Enter a value for each one as a SQL
      literal, for example <code>42</code>, <code>'paid'</code> or <code>now() - interval '7 days'</code>.
    </p>
    <pre class="sql">{preview}</pre>
    <div class="params">
      {#each request.params as n, i}
        <label>
          <span class="mono">${n}</span>
          {#if i === 0}
            <input type="text" bind:value={values[n]} bind:this={first} autocapitalize="off" spellcheck="false" />
          {:else}
            <input type="text" bind:value={values[n]} autocapitalize="off" spellcheck="false" />
          {/if}
        </label>
      {/each}
    </div>
    <div class="buttons">
      <button type="button" onclick={close}>Cancel</button>
      <span class="spacer"></span>
      {#if canGeneric}
        <button type="button" onclick={explainGeneric} title="EXPLAIN (GENERIC_PLAN): plans without values, so estimates cannot use statistics for specific constants">Generic plan (no values)</button>
      {/if}
      <button type="submit" class="primary" disabled={missing.length > 0}>Explain with values</button>
    </div>
  </form>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .dialog { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; width: 640px; max-width: 95vw; max-height: 90vh; overflow: auto; box-shadow: 0 12px 40px rgba(0,0,0,0.3); display: flex; flex-direction: column; gap: 10px; }
  h2 { margin: 0; font-size: 15px; }
  p { margin: 0; font-size: 12px; }
  code { font-family: var(--font-mono); background: var(--bg-2); padding: 0 4px; border-radius: 3px; }
  .sql { margin: 0; padding: 10px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow: auto; }
  .params { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px 14px; }
  label { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  label .mono { width: 32px; color: var(--fg-2); text-align: right; }
  label input { font-family: var(--font-mono); }
  .buttons { display: flex; gap: 6px; margin-top: 4px; }
  .spacer { flex: 1; }
</style>
