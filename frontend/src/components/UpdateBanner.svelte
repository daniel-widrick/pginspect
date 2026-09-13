<script lang="ts">
  // A newer release is available: one line above the workspace, with the
  // release notes a click away. Update installs and relaunches.
  import { onMount } from 'svelte'
  import { EventsOn, BrowserOpenURL } from '../../wailsjs/runtime/runtime'
  import { UpdateStatus, CheckForUpdate, SkipUpdate, ApplyUpdate } from '../../wailsjs/go/main/App'
  import type { update } from '../../wailsjs/go/models'
  import { toast, errorMessage } from '../lib/state.svelte'

  let status = $state<update.Status | null>(null)
  let dismissed = $state(false)
  let busy = $state(false)
  let notesOpen = $state(false)

  onMount(() => {
    UpdateStatus().then(s => (status = s)).catch(() => {})
    const offs = [
      EventsOn('update:status', (s: update.Status) => { status = s }),
      EventsOn('menu:checkupdate', () => void checkNow()),
    ]
    return () => offs.forEach(off => off())
  })

  async function checkNow() {
    dismissed = false
    try {
      const s = await CheckForUpdate(true)
      status = s
      if (s.state === 'unsupported') toast('This is a development build; updates apply to released versions.')
      else if (s.state === 'up-to-date') toast(`pginspect ${s.current} is the latest version.`)
      else if (s.state === 'error') toast(`Could not check for updates: ${s.error}`, 6000)
    } catch (e) {
      toast(`Could not check for updates: ${errorMessage(e)}`, 6000)
    }
  }

  async function apply() {
    busy = true
    try {
      await ApplyUpdate()
      toast('Installed. pginspect is restarting...')
    } catch (e) {
      toast(`Update failed: ${errorMessage(e)}`, 8000)
      busy = false
    }
  }

  function skip() {
    if (status?.available) void SkipUpdate(status.available.tag)
    dismissed = true
  }

  const rel = $derived(status?.available ?? null)
  const inFlight = $derived(!!status && ['downloading', 'verifying', 'installing', 'restarting'].includes(status.state))
</script>

{#if rel && !dismissed}
  <div class="banner" class:busy={inFlight}>
    <span class="what">
      <b>pginspect {rel.tag}</b> is available{status?.current ? ` (you have ${status.current})` : ''}.
      {#if rel.notes}<button class="link" onclick={() => (notesOpen = !notesOpen)}>{notesOpen ? 'Hide notes' : 'What changed'}</button>{/if}
      <button class="link" onclick={() => BrowserOpenURL(rel.url)}>Release page</button>
    </span>
    <span class="grow"></span>
    {#if inFlight}
      <span class="progress">
        {status?.state === 'downloading' ? `Downloading ${Math.round((status.progress ?? 0) * 100)}%` : status?.state === 'verifying' ? 'Verifying signature' : status?.state === 'installing' ? 'Installing' : 'Restarting'}
      </span>
    {:else}
      <button class="small primary" onclick={apply} disabled={busy}>Update and restart</button>
      <button class="small" onclick={skip}>Skip this version</button>
      <button class="ghost small" onclick={() => (dismissed = true)} title="Ask again next week">Later</button>
    {/if}
  </div>
  {#if notesOpen && rel.notes}
    <pre class="notes">{rel.notes}</pre>
  {/if}
{/if}

<style>
  .banner { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: color-mix(in srgb, var(--accent) 12%, var(--bg-2)); border-bottom: 1px solid var(--border); font-size: 12.5px; flex-shrink: 0; }
  .banner.busy { background: color-mix(in srgb, var(--accent) 20%, var(--bg-2)); }
  .grow { flex: 1; }
  .link { background: none; border: none; color: var(--accent); padding: 0 4px; cursor: pointer; font-size: 12.5px; }
  .link:hover { text-decoration: underline; background: none; }
  .progress { font-variant-numeric: tabular-nums; color: var(--fg-2); }
  .notes { margin: 0; padding: 8px 14px; max-height: 160px; overflow: auto; font-size: 12px; white-space: pre-wrap; background: var(--bg-2); border-bottom: 1px solid var(--border); font-family: var(--font-ui); flex-shrink: 0; }
</style>
