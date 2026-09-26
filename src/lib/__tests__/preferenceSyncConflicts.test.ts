/**
 * Multi-device preference sync conflicts — #891
 */

import { describe, expect, it } from 'vitest'
import {
  PreferenceSyncError,
  SNAPSHOT_FORMAT,
  applyConflictResolution,
  defaultChoices,
  detectPreferenceConflicts,
  ensureDeviceId,
  exportSyncSnapshot,
  formatPreferenceValue,
  newestSide,
  parseSyncSnapshot,
  toSnapshot,
  type PreferenceSnapshot,
  type SyncInput,
} from '../preferenceSyncConflicts'
import {
  CURRENT_PREFERENCE_SCHEMA_VERSION,
  migratePreferences,
  type UserPreferences,
} from '../userPreferences'

const NOW = new Date('2026-09-26T12:00:00.000Z')
const base = migratePreferences({})

function prefs(overrides: Record<string, unknown> = {}): UserPreferences {
  return migratePreferences({ ...base, ...overrides } as Partial<UserPreferences>)
}

function snap(deviceId: string, updatedAt: string, overrides: Record<string, unknown> = {}): PreferenceSnapshot {
  return { deviceId, updatedAt, preferences: prefs(overrides) }
}

const T1 = '2026-09-26T10:00:00.000Z'
const T2 = '2026-09-26T11:00:00.000Z'

function expectSyncError(fn: () => unknown, code: string) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(PreferenceSyncError)
    expect((e as PreferenceSyncError).code).toBe(code)
    return e as PreferenceSyncError
  }
  throw new Error(`expected PreferenceSyncError ${code}`)
}

describe('detectPreferenceConflicts', () => {
  it('auto-merges changes made on only one device', () => {
    const input: SyncInput = {
      base,
      local: snap('device-a', T1, { theme: 'light' }),
      remote: snap('device-b', T2, { currency: 'EUR' }),
    }
    const report = detectPreferenceConflicts(input)
    expect(report.conflicts).toEqual([])
    expect(report.autoMerged).toEqual([
      { path: 'theme', from: 'local' },
      { path: 'currency', from: 'remote' },
    ])

    const { preferences, applied } = applyConflictResolution(input, report, {}, NOW)
    expect(preferences.theme).toBe('light')
    expect(preferences.currency).toBe('EUR')
    expect(applied).toEqual({ theme: 'local', currency: 'remote' })
  })

  it('flags the same preference changed differently on both devices', () => {
    const report = detectPreferenceConflicts({
      base,
      local: snap('device-a', T1, { theme: 'light' }),
      remote: snap('device-b', T2, { theme: 'auto' }),
    })
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]).toMatchObject({ path: 'theme', base: 'dark', local: 'light', remote: 'auto' })
  })

  it('does not flag both devices making the same change (boundary)', () => {
    const report = detectPreferenceConflicts({
      base,
      local: snap('device-a', T1, { fontSize: 'large' }),
      remote: snap('device-b', T2, { fontSize: 'large' }),
    })
    expect(report).toEqual({ conflicts: [], autoMerged: [], hasBase: true })
  })

  it('treats every difference as a conflict on first sync without a base (boundary)', () => {
    const report = detectPreferenceConflicts({
      base: null,
      local: snap('device-a', T1, { theme: 'light' }),
      remote: snap('device-b', T2, { currency: 'EUR' }),
    })
    expect(report.hasBase).toBe(false)
    expect(report.conflicts.map((c) => c.path)).toEqual(['theme', 'currency'])
  })

  it('compares nested and list fields, ignoring object key order', () => {
    const addresses = [{ address: 'GA', label: 'a', addedAt: 1 }]
    const report = detectPreferenceConflicts({
      base,
      local: snap('device-a', T1, {
        savedAddresses: addresses,
        advanced: { ...base.advanced, 'data.refreshInterval': 30 },
      }),
      remote: snap('device-b', T2, {
        savedAddresses: [{ label: 'b', address: 'GB', addedAt: 2 }],
        advanced: Object.fromEntries(Object.entries({ ...base.advanced }).reverse()),
      }),
    })
    expect(report.conflicts.map((c) => c.path)).toEqual(['savedAddresses'])
  })

  it('marks sides holding values that fail validation', () => {
    const report = detectPreferenceConflicts({
      base,
      local: snap('device-a', T1, { theme: 'light' }),
      remote: snap('device-b', T2, { theme: 'neon' }),
    })
    expect(report.conflicts[0].invalidSides).toEqual(['remote'])
  })
})

describe('deterministic resolution', () => {
  const a = snap('device-a', T1, { theme: 'light', currency: 'XLM' })
  const b = snap('device-b', T2, { theme: 'auto', currency: 'EUR' })

  it('newest wins by default', () => {
    const report = detectPreferenceConflicts({ base, local: a, remote: b })
    expect(defaultChoices(report, 'newest', a, b)).toEqual({ theme: 'remote', currency: 'remote' })
    expect(defaultChoices(report, 'local', a, b)).toEqual({ theme: 'local', currency: 'local' })
  })

  it('breaks timestamp ties by device id so both devices pick the same winner', () => {
    const x = snap('device-x', T1)
    const y = snap('device-y', T1)
    expect(newestSide(x, y)).toBe('remote') // on device x, y wins
    expect(newestSide(y, x)).toBe('local') // on device y, y still wins
  })

  it('produces identical preferences on both devices', () => {
    const onA = detectPreferenceConflicts({ base, local: a, remote: b })
    const onB = detectPreferenceConflicts({ base, local: b, remote: a })
    const resultA = applyConflictResolution({ base, local: a, remote: b }, onA, defaultChoices(onA, 'newest', a, b), NOW)
    const resultB = applyConflictResolution({ base, local: b, remote: a }, onB, defaultChoices(onB, 'newest', b, a), NOW)
    const strip = (p: UserPreferences) => ({ ...p, sync: undefined })
    expect(strip(resultA.preferences)).toEqual(strip(resultB.preferences))
  })

  it('honours per-conflict user choices', () => {
    const input = { base, local: a, remote: b }
    const report = detectPreferenceConflicts(input)
    const { preferences } = applyConflictResolution(input, report, { theme: 'local', currency: 'remote' }, NOW)
    expect(preferences.theme).toBe('light')
    expect(preferences.currency).toBe('EUR')
  })

  it('records sync metadata and clears pending changes', () => {
    const input = { base, local: a, remote: b }
    const report = detectPreferenceConflicts(input)
    const { preferences } = applyConflictResolution(input, report, defaultChoices(report, 'newest', a, b), NOW)
    expect(preferences.sync).toMatchObject({
      deviceId: 'device-a',
      lastSyncedAt: NOW.toISOString(),
      pendingChanges: 0,
      remoteVersion: 1,
    })
  })

  it('avoids pre-selecting an invalid value even if that side is newer', () => {
    const local = snap('device-a', T1, { theme: 'light' })
    const remote = snap('device-b', T2, { theme: 'neon' })
    const report = detectPreferenceConflicts({ base, local, remote })
    expect(defaultChoices(report, 'newest', local, remote)).toEqual({ theme: 'local' })
  })
})

describe('failure paths', () => {
  const a = snap('device-a', T1, { theme: 'light' })
  const b = snap('device-b', T2, { theme: 'auto' })
  const input = { base, local: a, remote: b }

  it('rejects unresolved, unknown and malformed choices', () => {
    const report = detectPreferenceConflicts(input)
    expect(expectSyncError(() => applyConflictResolution(input, report, {}, NOW), 'UNRESOLVED_CONFLICT').details).toEqual(['theme'])
    expectSyncError(() => applyConflictResolution(input, report, { theme: 'local', currency: 'remote' }, NOW), 'UNKNOWN_CONFLICT')
    expectSyncError(() => applyConflictResolution(input, report, { theme: 'both' as never }, NOW), 'INVALID_CHOICE')
    expectSyncError(() => applyConflictResolution(input, report, null as never, NOW), 'INVALID_CHOICE')
  })

  it('refuses to save an invalid merge', () => {
    const remote = snap('device-b', T2, { theme: 'neon' })
    const bad = { base, local: a, remote }
    const report = detectPreferenceConflicts(bad)
    expectSyncError(() => applyConflictResolution(bad, report, { theme: 'remote' }, NOW), 'INVALID_RESULT')
  })

  it('rejects malformed snapshots', () => {
    expectSyncError(() => detectPreferenceConflicts({ base, local: a, remote: null as never }), 'INVALID_SNAPSHOT')
    const err = expectSyncError(
      () => detectPreferenceConflicts({ base, local: a, remote: { deviceId: '', updatedAt: 'yesterday', preferences: 1 } as never }),
      'INVALID_SNAPSHOT',
    )
    expect(err.details).toEqual(['deviceId is missing', 'updatedAt is not a valid timestamp', 'preferences are missing'])
  })

  it('refuses to merge preferences from a newer schema', () => {
    const future = { ...b, preferences: { ...b.preferences, schemaVersion: CURRENT_PREFERENCE_SCHEMA_VERSION + 1 } }
    expectSyncError(() => detectPreferenceConflicts({ base, local: a, remote: future }), 'INCOMPATIBLE_SCHEMA')
  })
})

describe('snapshots', () => {
  it('round-trips through export and parse', () => {
    const local = ensureDeviceId(prefs({ theme: 'light' }), () => 'abc')
    local.sync.lastModifiedAt = T2
    const parsed = parseSyncSnapshot(exportSyncSnapshot(local))
    expect(parsed).toEqual(toSnapshot(local))
    expect(parsed.updatedAt).toBe(T2)
  })

  it('assigns a device id once and keeps it', () => {
    const withId = ensureDeviceId(prefs(), () => 'abc')
    expect(withId.sync.deviceId).toBe('device-abc')
    expect(ensureDeviceId(withId, () => 'other')).toBe(withId)
  })

  it('refuses to export without a device id', () => {
    expectSyncError(() => exportSyncSnapshot(prefs()), 'INVALID_SNAPSHOT')
  })

  it('rejects text that is not a sync snapshot', () => {
    expectSyncError(() => parseSyncSnapshot('{oops'), 'INVALID_SNAPSHOT')
    expectSyncError(() => parseSyncSnapshot(JSON.stringify({ format: 'other' })), 'INVALID_SNAPSHOT')
    expect(SNAPSHOT_FORMAT).toMatch(/preferences-sync/)
  })

  it('formats values for display', () => {
    expect(formatPreferenceValue(true)).toBe('On')
    expect(formatPreferenceValue(undefined)).toBe('(not set)')
    expect(formatPreferenceValue([1, 2])).toBe('2 items')
    expect(formatPreferenceValue({ a: 1 })).toBe('1 setting')
  })
})
