<script lang="ts">
  import { store } from '../lib/state.svelte'
  import { connect, disconnect, blankProfile } from '../lib/connections.svelte'
  import { newQueryTab, openStatsTab, openSlowLogTab } from '../lib/tabs.svelte'
  import SchemaTree from './SchemaTree.svelte'

  let collapsed = $state<Record<string, boolean>>({})

  function edit(id: string) {
    const p = store.profiles.find(p => p.id === id)
    if (p) store.dialog = { kind: 'profile', profile: p }
  }
</script>

<aside class="sidebar">
  <div class="header">
    <span class="title">Connections</span>
    <button class="ghost small" title="New connection" onclick={() => (store.dialog = { kind: 'profile', profile: blankProfile() })}>+</button>
  </div>
  {#if store.profiles.length === 0}
    <div class="hint">
      No connections yet.<br />
      <button class="primary small" style="margin-top: 8px" onclick={() => (store.dialog = { kind: 'profile', profile: blankProfile() })}>Add a connection</button>
    </div>
  {/if}
  {#each store.profiles as p (p.id)}
    {@const info = store.connected[p.id]}
    <div class="profile" class:connected={!!info}>
      <div class="row" ondblclick={() => (info ? (collapsed[p.id] = !collapsed[p.id]) : connect(p.id))} role="button" tabindex="-1">
        <span class="dot" style="background: {p.color || (info ? 'var(--ok)' : 'var(--fg-3)')}"></span>
        <span class="name" title="{p.user}@{p.host}:{p.port}/{p.database}">{p.name}</span>
        {#if info}
          <span class="ver" title="PostgreSQL {info.serverVersion}">{info.serverVersion.split(' ')[0]}</span>
        {/if}
        <span class="actions">
          {#if info}
            <button class="ghost small" title="New query tab" onclick={() => newQueryTab(p.id)}>+</button>
            <button class="ghost small" title="Query statistics (pg_stat_statements)" onclick={() => openStatsTab(p.id)}>∑</button>
            <button class="ghost small" title="Slow statement log (server log files)" onclick={() => openSlowLogTab(p.id)}>⏱</button>
            <button class="ghost small" title="Edit" onclick={() => edit(p.id)}>✎</button>
            <button class="ghost small" title="Disconnect" onclick={() => disconnect(p.id)}>⏏</button>
          {:else}
            <button class="ghost small" title="Edit" onclick={() => edit(p.id)}>✎</button>
            <button class="small primary" disabled={store.connecting[p.id]} onclick={() => connect(p.id)}>
              {store.connecting[p.id] ? '...' : 'Connect'}
            </button>
          {/if}
        </span>
      </div>
      {#if info && !collapsed[p.id]}
        <SchemaTree connId={p.id} />
      {/if}
    </div>
  {/each}
</aside>

<style>
  .sidebar { height: 100%; overflow: auto; background: var(--bg-2); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
  .header { display: flex; align-items: center; padding: 8px 10px 6px; position: sticky; top: 0; background: var(--bg-2); z-index: 2; }
  .title { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-2); flex: 1; }
  .hint { padding: 10px 12px; color: var(--fg-2); }
  .profile { border-top: 1px solid var(--border); }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; min-height: 32px; }
  .row:hover { background: var(--bg-hover); }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ver { font-size: 10px; color: var(--fg-3); background: var(--bg-3); padding: 1px 5px; border-radius: 3px; }
  .actions { margin-left: auto; display: flex; gap: 2px; flex-shrink: 0; }
</style>
