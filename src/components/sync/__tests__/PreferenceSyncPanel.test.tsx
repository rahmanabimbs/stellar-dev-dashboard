import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import PreferenceSyncPanel, { type PreferenceSyncStore } from '../PreferenceSyncPanel'
import { exportSyncSnapshot, ensureDeviceId } from '../../../lib/preferenceSyncConflicts'
import { migratePreferences, type UserPreferences } from '../../../lib/userPreferences'

const NOW = new Date('2026-09-26T12:00:00.000Z')

function makeStore(local: UserPreferences, base: UserPreferences | null) {
  const state = { local, base }
  const store: PreferenceSyncStore = {
    load: vi.fn(async () => state.local),
    save: vi.fn(async (p) => (state.local = p)),
    loadBase: vi.fn(async () => state.base),
    saveBase: vi.fn(async (p) => void (state.base = p)),
  }
  return { store, state }
}

function device(id: string, modifiedAt: string, overrides: Partial<UserPreferences> = {}) {
  const p = ensureDeviceId(migratePreferences(overrides), () => id)
  p.sync.lastModifiedAt = modifiedAt
  return p
}

const paste = (text: string) =>
  fireEvent.change(screen.getByLabelText('Snapshot from another device'), { target: { value: text } })

describe('PreferenceSyncPanel (#891)', () => {
  it('resolves a conflict through the dialog and saves the merge', async () => {
    const base = migratePreferences({})
    const { store, state } = makeStore(device('a', '2026-09-26T10:00:00Z', { theme: 'light' }), base)
    const remote = device('b', '2026-09-26T11:00:00Z', { theme: 'auto' })
    render(<PreferenceSyncPanel store={store} now={() => NOW} />)

    paste(exportSyncSnapshot(remote))
    fireEvent.click(screen.getByText('Compare and merge'))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Resolve 1 preference conflict')
    // Newest wins by default: the other device changed theme later.
    expect(screen.getByLabelText(/Other device:.*auto/)).toBeChecked()

    fireEvent.click(screen.getByLabelText(/This device:.*light/))
    fireEvent.click(screen.getByText('Apply resolution'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(state.local.theme).toBe('light')
    expect(state.base?.theme).toBe('light')
    expect(screen.getByRole('status')).toHaveTextContent('Conflicts resolved')
  })

  it('merges without a dialog when nothing conflicts', async () => {
    const base = migratePreferences({})
    const { store, state } = makeStore(device('a', '2026-09-26T10:00:00Z'), base)
    render(<PreferenceSyncPanel store={store} now={() => NOW} />)

    paste(exportSyncSnapshot(device('b', '2026-09-26T11:00:00Z', { currency: 'EUR' })))
    fireEvent.click(screen.getByText('Compare and merge'))

    await screen.findByText(/Merged 1 change with no conflicts/)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(state.local.currency).toBe('EUR')
  })

  it('leaves preferences untouched when the dialog is cancelled', async () => {
    const { store, state } = makeStore(device('a', '2026-09-26T10:00:00Z', { theme: 'light' }), null)
    render(<PreferenceSyncPanel store={store} now={() => NOW} />)

    paste(exportSyncSnapshot(device('b', '2026-09-26T11:00:00Z', { theme: 'auto' })))
    fireEvent.click(screen.getByText('Compare and merge'))
    fireEvent.click(await screen.findByText('Cancel'))

    expect(screen.getByRole('status')).toHaveTextContent('Nothing was changed')
    expect(state.local.theme).toBe('light')
    expect(store.saveBase).not.toHaveBeenCalled()
  })

  it.each([
    ['', /Paste a snapshot/],
    ['not json', /not valid JSON/],
    [JSON.stringify({ format: 'nope' }), /not a preferences sync snapshot/],
  ])('shows an error for invalid input %j', async (text, message) => {
    const { store } = makeStore(device('a', '2026-09-26T10:00:00Z'), null)
    render(<PreferenceSyncPanel store={store} now={() => NOW} />)
    paste(text)
    fireEvent.click(screen.getByText('Compare and merge'))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('rejects a snapshot from the same device', async () => {
    const local = device('a', '2026-09-26T10:00:00Z')
    const { store } = makeStore(local, null)
    render(<PreferenceSyncPanel store={store} now={() => NOW} />)
    paste(exportSyncSnapshot(local))
    fireEvent.click(screen.getByText('Compare and merge'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/came from this device/)
  })

  it('assigns a device id before creating a snapshot', async () => {
    const { store, state } = makeStore(migratePreferences({}), null)
    render(<PreferenceSyncPanel store={store} now={() => NOW} />)
    fireEvent.click(screen.getByText('Create sync snapshot'))
    const box = await screen.findByLabelText('Sync snapshot for this device')
    expect(state.local.sync.deviceId).toMatch(/^device-/)
    expect(JSON.parse((box as HTMLTextAreaElement).value).deviceId).toBe(state.local.sync.deviceId)
  })
})
