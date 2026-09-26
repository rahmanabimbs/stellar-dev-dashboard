/**
 * PreferenceSyncPanel — move preferences between devices and resolve
 * conflicts (#891). Copy a snapshot on one device, paste it on another.
 */

import React, { useState } from 'react'
import PreferenceConflictDialog from './PreferenceConflictDialog'
import {
  PreferenceSyncError,
  applyConflictResolution,
  detectPreferenceConflicts,
  ensureDeviceId,
  exportSyncSnapshot,
  parseSyncSnapshot,
  toSnapshot,
  type ConflictReport,
  type SyncInput,
} from '../../lib/preferenceSyncConflicts'
import {
  loadPreferences,
  savePreferences,
  type UserPreferences,
} from '../../lib/userPreferences'
import { getStoredValue, setStoredValue } from '../../lib/storage'

/** Last preferences both devices agreed on; the base for three-way merges. */
export const SYNC_BASE_KEY = 'preference-sync-base-v1'

export interface PreferenceSyncStore {
  load: () => Promise<UserPreferences>
  save: (prefs: UserPreferences) => Promise<UserPreferences>
  loadBase: () => Promise<UserPreferences | null>
  saveBase: (prefs: UserPreferences) => Promise<void>
}

const defaultStore: PreferenceSyncStore = {
  load: loadPreferences,
  save: (prefs) => savePreferences({ ...prefs, sync: { ...prefs.sync } }),
  loadBase: async () => ((await getStoredValue(SYNC_BASE_KEY)) as UserPreferences | null) ?? null,
  saveBase: async (prefs) => {
    await setStoredValue(SYNC_BASE_KEY, prefs)
  },
}

type Status = { kind: 'info' | 'error'; text: string } | null

export default function PreferenceSyncPanel({
  store = defaultStore,
  now = () => new Date(),
}: {
  store?: PreferenceSyncStore
  now?: () => Date
}) {
  const [snapshot, setSnapshot] = useState('')
  const [incoming, setIncoming] = useState('')
  const [pending, setPending] = useState<{ input: SyncInput; report: ConflictReport; strategy: UserPreferences['sync']['conflictStrategy'] } | null>(null)
  const [status, setStatus] = useState<Status>(null)

  const describe = (e: unknown) =>
    e instanceof PreferenceSyncError
      ? `${e.message}${e.details.length ? ` (${e.details.join(', ')})` : ''}`
      : e instanceof Error
        ? e.message
        : 'Something went wrong.'

  const localPrefs = async () => {
    const current = await store.load()
    const withId = ensureDeviceId(current)
    return withId === current ? current : store.save(withId)
  }

  const handleCreateSnapshot = async () => {
    setStatus(null)
    try {
      setSnapshot(exportSyncSnapshot(await localPrefs()))
      setStatus({ kind: 'info', text: 'Snapshot created. Paste it on your other device.' })
    } catch (e) {
      setStatus({ kind: 'error', text: describe(e) })
    }
  }

  const finish = async (preferences: UserPreferences, message: string) => {
    const saved = await store.save(preferences)
    await store.saveBase(saved)
    setPending(null)
    setIncoming('')
    setStatus({ kind: 'info', text: message })
  }

  const handleCompare = async () => {
    setStatus(null)
    if (incoming.trim() === '') {
      setStatus({ kind: 'error', text: 'Paste a snapshot from your other device first.' })
      return
    }
    try {
      const remote = parseSyncSnapshot(incoming)
      const prefs = await localPrefs()
      const local = toSnapshot(prefs)
      if (remote.deviceId === local.deviceId) {
        setStatus({ kind: 'error', text: 'This snapshot came from this device. Paste one from your other device.' })
        return
      }
      const input: SyncInput = { base: await store.loadBase(), local, remote }
      const report = detectPreferenceConflicts(input)

      if (report.conflicts.length === 0) {
        const { preferences } = applyConflictResolution(input, report, {}, now())
        await finish(
          preferences,
          report.autoMerged.length === 0
            ? 'Already in sync. Nothing to change.'
            : `Merged ${report.autoMerged.length} change${report.autoMerged.length === 1 ? '' : 's'} with no conflicts.`,
        )
        return
      }
      setPending({ input, report, strategy: prefs.sync.conflictStrategy })
    } catch (e) {
      setStatus({ kind: 'error', text: describe(e) })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button type="button" onClick={handleCreateSnapshot} style={buttonStyle}>
          Create sync snapshot
        </button>
      </div>
      {snapshot && (
        <textarea
          readOnly
          aria-label="Sync snapshot for this device"
          value={snapshot}
          rows={3}
          style={textareaStyle}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}

      <label htmlFor="incoming-snapshot" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
        Snapshot from another device
      </label>
      <textarea
        id="incoming-snapshot"
        value={incoming}
        rows={3}
        onChange={(e) => setIncoming(e.target.value)}
        style={textareaStyle}
      />
      <div>
        <button type="button" onClick={handleCompare} style={buttonStyle} disabled={pending !== null}>
          Compare and merge
        </button>
      </div>

      {status && (
        <div role={status.kind === 'error' ? 'alert' : 'status'} style={{ fontSize: '12px', color: status.kind === 'error' ? 'var(--error)' : 'var(--text-secondary)' }}>
          {status.text}
        </div>
      )}

      {pending && (
        <PreferenceConflictDialog
          input={pending.input}
          report={pending.report}
          strategy={pending.strategy}
          now={now}
          onCancel={() => {
            setPending(null)
            setStatus({ kind: 'info', text: 'Sync cancelled. Nothing was changed.' })
          }}
          onResolve={(preferences) => finish(preferences, 'Conflicts resolved and preferences saved.')}
        />
      )}
    </div>
  )
}

const buttonStyle = {
  padding: '6px 10px',
  fontSize: '12px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
}

const textareaStyle = {
  width: '100%',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '8px',
  boxSizing: 'border-box' as const,
}
