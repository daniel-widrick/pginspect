// Connection lifecycle: profiles, connect/disconnect, password prompting.
import {
  Connect, Disconnect, ListProfiles, SaveProfile, DeleteProfile, ConnectedIDs,
} from '../../wailsjs/go/main/App'
import type { config } from '../../wailsjs/go/models'
import { store, errorMessage, toast } from './state.svelte'
import { closeTabsForConnection, newQueryTab } from './tabs.svelte'

export async function loadProfiles(): Promise<void> {
  try {
    // Plain objects: Svelte 5 only makes plain objects and arrays reactive.
    store.profiles = (await ListProfiles()).map(p => ({ ...p }) as config.Profile)
    const ids = await ConnectedIDs()
    for (const id of Object.keys(store.connected)) {
      if (!ids.includes(id)) delete store.connected[id]
    }
  } catch (e) {
    toast(`Could not load profiles: ${errorMessage(e)}`)
  }
}

export function blankProfile(): config.Profile {
  return {
    id: '', name: '', host: 'localhost', port: 5432, database: '', user: '',
    sslMode: 'prefer', savePassword: true, color: '',
  } as config.Profile
}

/** Connects a profile, prompting for a password if none is stored. */
export async function connect(id: string, password = ''): Promise<boolean> {
  if (store.connecting[id]) return false
  store.connecting[id] = true
  try {
    const info = await Connect(id, password)
    store.connected[id] = info
    if (!store.tabs.some(t => t.connId === id)) newQueryTab(id)
    return true
  } catch (e) {
    const msg = errorMessage(e)
    if (msg.includes('PASSWORD_REQUIRED')) {
      store.dialog = { kind: 'password', profileId: id, error: '', busy: false }
    } else if (store.dialog?.kind === 'password') {
      store.dialog.error = msg
    } else {
      toast(`Connection failed: ${msg}`, 6000)
    }
    return false
  } finally {
    store.connecting[id] = false
  }
}

export async function disconnect(id: string): Promise<void> {
  await Disconnect(id)
  delete store.connected[id]
  delete store.schemas[id]
  closeTabsForConnection(id)
}

export async function saveProfile(p: config.Profile, password: string): Promise<config.Profile> {
  const saved = await SaveProfile(p, password)
  await loadProfiles()
  return saved
}

export async function deleteProfile(id: string): Promise<void> {
  await DeleteProfile(id)
  delete store.connected[id]
  closeTabsForConnection(id)
  await loadProfiles()
}
