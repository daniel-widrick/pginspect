<script lang="ts">
  import { store, profileName, errorMessage } from '../lib/state.svelte'
  import { connect, saveProfile } from '../lib/connections.svelte'

  interface Props { profileId: string }
  let { profileId }: Props = $props()

  let password = $state('')
  let remember = $state(false)
  let input: HTMLInputElement | undefined

  $effect(() => { input?.focus() })

  const dialog = $derived(store.dialog?.kind === 'password' ? store.dialog : null)

  function close() { store.dialog = null }

  async function submit(e: Event) {
    e.preventDefault()
    if (!dialog) return
    dialog.busy = true
    dialog.error = ''
    try {
      if (remember) {
        const p = store.profiles.find(p => p.id === profileId)
        if (p) { p.savePassword = true; await saveProfile(p, password) }
      }
      const ok = await connect(profileId, password)
      if (ok) close()
    } catch (err) {
      dialog.error = errorMessage(err)
    } finally {
      if (store.dialog?.kind === 'password') store.dialog.busy = false
    }
  }
</script>

<div class="backdrop" onclick={close} onkeydown={(e) => e.key === 'Escape' && close()} role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions, a11y_no_static_element_interactions -->
  <form class="dialog" onclick={(e) => e.stopPropagation()} onsubmit={submit}>
    <h2>Password for {profileName(profileId)}</h2>
    <input type="password" bind:value={password} bind:this={input} placeholder="Password" />
    <label class="check"><input type="checkbox" bind:checked={remember} /> Remember in keychain</label>
    {#if dialog?.error}<div class="error-text">{dialog.error}</div>{/if}
    <div class="buttons">
      <button type="button" onclick={close}>Cancel</button>
      <button type="submit" class="primary" disabled={dialog?.busy}>{dialog?.busy ? 'Connecting...' : 'Connect'}</button>
    </div>
  </form>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .dialog { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; width: 360px; box-shadow: 0 12px 40px rgba(0,0,0,0.3); display: flex; flex-direction: column; gap: 10px; }
  h2 { margin: 0; font-size: 14px; }
  .check { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .buttons { display: flex; justify-content: flex-end; gap: 6px; }
</style>
