<script lang="ts">
  import { TestConnection } from '../../wailsjs/go/main/App'
  import type { config } from '../../wailsjs/go/models'
  import { store, errorMessage, toast } from '../lib/state.svelte'
  import { saveProfile, deleteProfile, connect } from '../lib/connections.svelte'

  interface Props { profile: config.Profile }
  let { profile }: Props = $props()

  // svelte-ignore state_referenced_locally
  let form = $state<config.Profile>({ ...profile })
  let password = $state('')
  let status = $state<{ ok: boolean; text: string } | null>(null)
  let busy = $state(false)

  const colors = ['', '#2f6fdb', '#2e9b5a', '#c98a1a', '#c93b3b', '#8e44ad']

  function close() { store.dialog = null }

  async function test() {
    busy = true; status = null
    try {
      status = { ok: true, text: await TestConnection(form, password) }
    } catch (e) {
      status = { ok: false, text: errorMessage(e) }
    } finally { busy = false }
  }

  async function save(andConnect: boolean) {
    if (!form.name.trim()) form.name = `${form.user}@${form.host}/${form.database}`
    busy = true
    try {
      const saved = await saveProfile(form, password)
      close()
      if (andConnect) await connect(saved.id, form.savePassword ? '' : password)
    } catch (e) {
      status = { ok: false, text: errorMessage(e) }
    } finally { busy = false }
  }

  async function remove() {
    if (!confirm(`Delete connection "${form.name}"?`)) return
    try { await deleteProfile(form.id); close(); toast('Connection deleted') }
    catch (e) { status = { ok: false, text: errorMessage(e) } }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save(true)
  }
</script>

<div class="backdrop" onclick={close} onkeydown={onKey} role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
  <form class="dialog" onclick={(e) => e.stopPropagation()} onsubmit={(e) => { e.preventDefault(); void save(true) }}>
    <h2>{form.id ? 'Edit connection' : 'New connection'}</h2>

    <label>Name <input type="text" bind:value={form.name} placeholder="Production read replica" /></label>
    <div class="grid2">
      <label class="wide">Host <input type="text" bind:value={form.host} required /></label>
      <label>Port <input type="number" bind:value={form.port} min="1" max="65535" /></label>
    </div>
    <label>Database <input type="text" bind:value={form.database} required /></label>
    <div class="grid2 even">
      <label>User <input type="text" bind:value={form.user} required autocapitalize="off" /></label>
      <label>Password <input type="password" bind:value={password} placeholder={form.id ? '(unchanged)' : ''} /></label>
    </div>
    <div class="grid2 even">
      <label>SSL mode
        <select bind:value={form.sslMode}>
          {#each ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'] as m}
            <option value={m}>{m}</option>
          {/each}
        </select>
      </label>
      <label>Color
        <span class="swatches">
          {#each colors as c}
            <button type="button" class="swatch" class:active={form.color === c} style="background: {c || 'var(--bg-3)'}" onclick={() => (form.color = c)} aria-label={c || 'none'}></button>
          {/each}
        </span>
      </label>
    </div>
    <label class="check"><input type="checkbox" bind:checked={form.savePassword} /> Save password in the system keychain</label>

    {#if status}
      <div class="status" class:ok={status.ok} class:bad={!status.ok}>{status.text}</div>
    {/if}

    <div class="buttons">
      {#if form.id}<button type="button" class="danger" onclick={remove} disabled={busy}>Delete</button>{/if}
      <span class="spacer"></span>
      <button type="button" onclick={close}>Cancel</button>
      <button type="button" onclick={test} disabled={busy}>Test</button>
      <button type="button" onclick={() => save(false)} disabled={busy}>Save</button>
      <button type="submit" class="primary" disabled={busy}>Save &amp; Connect</button>
    </div>
  </form>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .dialog { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; width: 460px; max-width: 95vw; box-shadow: 0 12px 40px rgba(0,0,0,0.3); display: flex; flex-direction: column; gap: 10px; }
  h2 { margin: 0 0 4px; font-size: 15px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--fg-2); }
  label.check { flex-direction: row; align-items: center; gap: 8px; color: var(--fg); }
  .grid2 { display: grid; grid-template-columns: 1fr 100px; gap: 10px; }
  .grid2.even { grid-template-columns: 1fr 1fr; }
  .swatches { display: flex; gap: 6px; padding-top: 4px; }
  .swatch { width: 22px; height: 22px; border-radius: 50%; padding: 0; border: 2px solid transparent; }
  .swatch.active { border-color: var(--fg); }
  .status { padding: 8px 10px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; font-family: var(--font-mono); }
  .status.ok { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .status.bad { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); }
  .buttons { display: flex; gap: 6px; margin-top: 6px; }
  .spacer { flex: 1; }
</style>
