<script lang="ts">
  import { ClipboardSetText } from '../../wailsjs/runtime/runtime'
  import { toast, type StructureTab } from '../lib/state.svelte'
  import { newQueryTab, runQuery } from '../lib/tabs.svelte'

  interface Props { tab: StructureTab }
  let { tab }: Props = $props()

  const conTypes: Record<string, string> = { p: 'PRIMARY KEY', f: 'FOREIGN KEY', u: 'UNIQUE', c: 'CHECK', x: 'EXCLUDE', n: 'NOT NULL' }

  function queryData() {
    const sql = `select *\nfrom "${tab.schema}"."${tab.name}"\nlimit 200;`
    const t = newQueryTab(tab.connId, sql, tab.name)
    void runQuery(t, sql)
  }
</script>

<div class="structure">
  {#if tab.loading}
    <div class="pad muted">Loading...</div>
  {:else if tab.error}
    <div class="pad error-text">{tab.error}</div>
  {:else if tab.info}
    {@const info = tab.info}
    <div class="head">
      <div>
        <span class="kind">{info.relation.kind}</span>
        <span class="name mono">{info.relation.schema}.{info.relation.name}</span>
        {#if info.relation.rowsEst > 0}<span class="muted">~{info.relation.rowsEst.toLocaleString()} rows</span>{/if}
      </div>
      <div class="actions">
        <button class="small" onclick={queryData}>▶ Query data</button>
        <button class="small" onclick={() => newQueryTab(tab.connId, info.ddl, `${tab.name} DDL`)}>Open DDL in editor</button>
        <button class="small" onclick={() => { void ClipboardSetText(info.ddl); toast('DDL copied') }}>Copy DDL</button>
      </div>
    </div>
    {#if info.relation.comment}<div class="pad muted">{info.relation.comment}</div>{/if}

    <h3>Columns</h3>
    <table>
      <thead><tr><th></th><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th><th>Comment</th></tr></thead>
      <tbody>
        {#each info.columns as c}
          <tr>
            <td class="center">{c.primaryKey ? '🔑' : ''}</td>
            <td class="mono">{c.name}</td>
            <td class="mono">{c.type}</td>
            <td>{c.notNull ? 'not null' : 'null'}</td>
            <td class="mono">{c.default}</td>
            <td>{c.comment}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    {#if info.constraints.length}
      <h3>Constraints</h3>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Definition</th></tr></thead>
        <tbody>
          {#each info.constraints as c}
            <tr><td class="mono">{c.name}</td><td>{conTypes[c.type] ?? c.type}</td><td class="mono">{c.definition}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}

    {#if info.indexes.length}
      <h3>Indexes</h3>
      <table>
        <thead><tr><th>Name</th><th>Definition</th></tr></thead>
        <tbody>
          {#each info.indexes as ix}
            <tr><td class="mono">{ix.name}</td><td class="mono">{ix.definition}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <h3>DDL</h3>
    <pre class="ddl">{info.ddl}</pre>
  {/if}
</div>

<style>
  .structure { height: 100%; overflow: auto; padding: 0 0 20px; }
  .pad { padding: 10px 16px; }
  .head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; gap: 10px; flex-wrap: wrap; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); }
  .kind { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-2); background: var(--bg-3); padding: 2px 6px; border-radius: 3px; margin-right: 6px; }
  .name { font-weight: 600; font-size: 14px; margin-right: 8px; }
  .actions { display: flex; gap: 6px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-2); margin: 16px 16px 6px; }
  table { border-collapse: collapse; margin: 0 16px; font-size: 12px; }
  th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--fg-2); font-weight: 600; font-size: 11px; }
  td.center { text-align: center; }
  .ddl { margin: 0 16px; padding: 12px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; font-family: var(--font-mono); font-size: 12px; white-space: pre; overflow: auto; }
</style>
