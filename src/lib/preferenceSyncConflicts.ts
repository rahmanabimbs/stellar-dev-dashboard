/**
 * Multi-device preference sync: conflict detection and resolution (#891)
 *
 * Preferences written on two devices since their last common sync are merged
 * with a three-way diff against that common `base`:
 *
 *   - changed on one side only       → taken automatically
 *   - changed to the same value      → taken automatically
 *   - changed to different values    → a conflict the user resolves
 *   - no base (first sync)           → every difference is a conflict
 *
 * Resolution is deterministic: given the same snapshots and choices, both
 * devices produce the same merged preferences. The default choice for each
 * conflict follows the configured strategy; for `newest`, ties on timestamp
 * are broken by device id so both devices pick the same winner.
 *
 * See docs/guides/preference-sync-conflicts.md.
 */

import {
  CURRENT_PREFERENCE_SCHEMA_VERSION,
  PREFERENCE_SCHEMA,
  migratePreferences,
  validatePreferences,
  type PreferenceCategory,
  type PreferenceSyncState,
  type UserPreferences,
} from './userPreferences'

export type SyncSide = 'local' | 'remote'
export type ConflictStrategy = PreferenceSyncState['conflictStrategy']

/** A device's preferences plus the metadata needed to order writes. */
export interface PreferenceSnapshot {
  deviceId: string
  /** ISO timestamp of the last local write on that device. */
  updatedAt: string
  preferences: UserPreferences
}

export interface PreferenceConflict {
  path: string
  label: string
  category: PreferenceCategory | 'data'
  base: unknown
  local: unknown
  remote: unknown
  /** Sides whose value fails preference validation and cannot be chosen. */
  invalidSides: SyncSide[]
}

export interface ConflictReport {
  conflicts: PreferenceConflict[]
  /** Non-conflicting changes merged automatically, and which side they came from. */
  autoMerged: { path: string; from: SyncSide }[]
  /** False on a first sync, where every difference is treated as a conflict. */
  hasBase: boolean
}

export type ResolutionChoices = Record<string, SyncSide>

export type PreferenceSyncErrorCode =
  | 'INVALID_SNAPSHOT'
  | 'INCOMPATIBLE_SCHEMA'
  | 'UNRESOLVED_CONFLICT'
  | 'UNKNOWN_CONFLICT'
  | 'INVALID_CHOICE'
  | 'INVALID_RESULT'

export class PreferenceSyncError extends Error {
  readonly code: PreferenceSyncErrorCode
  readonly details: string[]
  constructor(code: PreferenceSyncErrorCode, message: string, details: string[] = []) {
    super(message)
    this.name = 'PreferenceSyncError'
    this.code = code
    this.details = details
  }
}

// ─── Tracked fields ───────────────────────────────────────────────────────────

/** Synced fields outside PREFERENCE_SCHEMA. Compared as whole values. */
const EXTRA_SYNCED_FIELDS: { path: string; label: string }[] = [
  { path: 'savedAddresses', label: 'Address book' },
  { path: 'dashboardLayout', label: 'Dashboard layout' },
  { path: 'customPresets', label: 'Custom presets' },
  { path: 'customNetworkProfiles', label: 'Custom network profiles' },
  { path: 'activeCustomProfile', label: 'Active network profile' },
  { path: 'transactionConfirmation', label: 'Transaction confirmation' },
  { path: 'notificationPreferences', label: 'Notification preferences' },
]

export interface SyncedField {
  path: string
  label: string
  category: PreferenceCategory | 'data'
}

/** Every preference path that participates in sync, in a stable order. */
export function getSyncedFields(): SyncedField[] {
  return [
    ...PREFERENCE_SCHEMA.map((d) => ({ path: d.path, label: d.label, category: d.category })),
    ...EXTRA_SYNCED_FIELDS.map((f) => ({ ...f, category: 'data' as const })),
  ]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, key) => (isPlainObject(v) ? v[key] : undefined), source)
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let node = target
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  const last = keys[keys.length - 1]
  if (value === undefined) delete node[last]
  else node[last] = cloneJson(value)
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

/** Order-insensitive for object keys, so `{a,b}` equals `{b,a}`. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function same(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function timeOf(snapshot: PreferenceSnapshot): number {
  return new Date(snapshot.updatedAt).getTime()
}

/** Whether `value` at `path` passes schema validation. */
function isValueValid(path: string, value: unknown): boolean {
  const probe = migratePreferences({}) as unknown as Record<string, unknown>
  writePath(probe, path, value)
  const { errors } = validatePreferences(probe as unknown as UserPreferences)
  return !errors.some((e) => e.startsWith(`${path} `))
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateSnapshot(snapshot: unknown, label: string): PreferenceSnapshot {
  const problems: string[] = []
  const s = snapshot as PreferenceSnapshot
  if (!isPlainObject(snapshot)) {
    throw new PreferenceSyncError('INVALID_SNAPSHOT', `${label} snapshot must be an object.`)
  }
  if (typeof s.deviceId !== 'string' || s.deviceId.trim() === '') problems.push('deviceId is missing')
  if (typeof s.updatedAt !== 'string' || Number.isNaN(new Date(s.updatedAt).getTime())) {
    problems.push('updatedAt is not a valid timestamp')
  }
  if (!isPlainObject(s.preferences)) problems.push('preferences are missing')
  if (problems.length > 0) {
    throw new PreferenceSyncError('INVALID_SNAPSHOT', `${label} snapshot is invalid.`, problems)
  }

  const version = s.preferences.schemaVersion
  if (typeof version === 'number' && version > CURRENT_PREFERENCE_SCHEMA_VERSION) {
    throw new PreferenceSyncError(
      'INCOMPATIBLE_SCHEMA',
      `${label} preferences use schema v${version}, newer than this app (v${CURRENT_PREFERENCE_SCHEMA_VERSION}). Update the app on this device before syncing.`,
    )
  }
  return { ...s, preferences: migratePreferences(s.preferences) }
}

// ─── Detection ────────────────────────────────────────────────────────────────

export interface SyncInput {
  /** Preferences as of the last successful sync between the devices, if known. */
  base?: UserPreferences | null
  local: PreferenceSnapshot
  remote: PreferenceSnapshot
}

export function detectPreferenceConflicts(input: SyncInput): ConflictReport {
  const local = validateSnapshot(input?.local, 'Local')
  const remote = validateSnapshot(input?.remote, 'Remote')
  const base = isPlainObject(input.base) ? migratePreferences(input.base) : null

  const report: ConflictReport = { conflicts: [], autoMerged: [], hasBase: base !== null }

  for (const field of getSyncedFields()) {
    const l = readPath(local.preferences, field.path)
    const r = readPath(remote.preferences, field.path)
    if (same(l, r)) continue

    if (base) {
      const b = readPath(base, field.path)
      if (same(b, l)) {
        report.autoMerged.push({ path: field.path, from: 'remote' })
        continue
      }
      if (same(b, r)) {
        report.autoMerged.push({ path: field.path, from: 'local' })
        continue
      }
    }

    report.conflicts.push({
      ...field,
      base: base ? readPath(base, field.path) : undefined,
      local: l,
      remote: r,
      invalidSides: (['local', 'remote'] as SyncSide[]).filter(
        (side) => !isValueValid(field.path, side === 'local' ? l : r),
      ),
    })
  }

  return report
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/** Which side wins under `newest`, identical on both devices. */
export function newestSide(local: PreferenceSnapshot, remote: PreferenceSnapshot): SyncSide {
  const lt = timeOf(local)
  const rt = timeOf(remote)
  if (lt !== rt) return rt > lt ? 'remote' : 'local'
  if (local.deviceId !== remote.deviceId) return remote.deviceId > local.deviceId ? 'remote' : 'local'
  return 'local'
}

/** Pre-selected choice per conflict for a strategy, avoiding invalid values. */
export function defaultChoices(
  report: ConflictReport,
  strategy: ConflictStrategy,
  local: PreferenceSnapshot,
  remote: PreferenceSnapshot,
): ResolutionChoices {
  const preferred: SyncSide =
    strategy === 'local' ? 'local' : strategy === 'remote' ? 'remote' : newestSide(local, remote)
  const choices: ResolutionChoices = {}
  for (const conflict of report.conflicts) {
    const other: SyncSide = preferred === 'local' ? 'remote' : 'local'
    choices[conflict.path] =
      conflict.invalidSides.includes(preferred) && !conflict.invalidSides.includes(other) ? other : preferred
  }
  return choices
}

export interface ResolutionResult {
  preferences: UserPreferences
  /** Final side used for every changed path (conflicts and auto-merges). */
  applied: Record<string, SyncSide>
}

/**
 * Merge the two snapshots. Every conflict needs a choice; choices for paths
 * that are not conflicts are rejected so stale UI state cannot slip through.
 */
export function applyConflictResolution(
  input: SyncInput,
  report: ConflictReport,
  choices: ResolutionChoices,
  now: Date = new Date(),
): ResolutionResult {
  const local = validateSnapshot(input?.local, 'Local')
  const remote = validateSnapshot(input?.remote, 'Remote')
  if (!isPlainObject(choices)) {
    throw new PreferenceSyncError('INVALID_CHOICE', 'Choices must be an object keyed by preference path.')
  }

  const conflictPaths = new Set(report.conflicts.map((c) => c.path))
  const unknown = Object.keys(choices).filter((p) => !conflictPaths.has(p))
  if (unknown.length > 0) {
    throw new PreferenceSyncError('UNKNOWN_CONFLICT', 'Choices include paths that are not in conflict.', unknown)
  }
  const invalid = Object.entries(choices).filter(([, side]) => side !== 'local' && side !== 'remote')
  if (invalid.length > 0) {
    throw new PreferenceSyncError(
      'INVALID_CHOICE',
      'Each choice must be "local" or "remote".',
      invalid.map(([p]) => p),
    )
  }
  const unresolved = [...conflictPaths].filter((p) => !(p in choices))
  if (unresolved.length > 0) {
    throw new PreferenceSyncError('UNRESOLVED_CONFLICT', 'Choose a value for every conflict.', unresolved)
  }

  const merged = cloneJson(local.preferences) as unknown as Record<string, unknown>
  const applied: Record<string, SyncSide> = {}

  for (const { path, from } of report.autoMerged) {
    applied[path] = from
    if (from === 'remote') writePath(merged, path, readPath(remote.preferences, path))
  }
  for (const path of conflictPaths) {
    applied[path] = choices[path]
    if (choices[path] === 'remote') writePath(merged, path, readPath(remote.preferences, path))
  }

  const result = migratePreferences(merged as unknown as UserPreferences)
  const validation = validatePreferences(result)
  if (!validation.valid) {
    throw new PreferenceSyncError('INVALID_RESULT', 'The merged preferences are invalid.', validation.errors)
  }

  result.sync = {
    ...local.preferences.sync,
    deviceId: local.deviceId,
    lastSyncedAt: now.toISOString(),
    lastModifiedAt: now.toISOString(),
    remoteVersion: Math.max(local.preferences.sync.remoteVersion ?? 0, remote.preferences.sync.remoteVersion ?? 0) + 1,
    pendingChanges: 0,
  }
  return { preferences: result, applied }
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

export const SNAPSHOT_FORMAT = 'stellar-dev-dashboard/preferences-sync'

/**
 * Snapshot of this device's preferences. `updatedAt` is the last local write
 * (falling back to the last sync, then the epoch), not the export time, so
 * "newest wins" compares when each device actually changed its settings.
 */
export function toSnapshot(preferences: UserPreferences): PreferenceSnapshot {
  const deviceId = preferences.sync?.deviceId
  if (!deviceId || deviceId === 'local') {
    throw new PreferenceSyncError(
      'INVALID_SNAPSHOT',
      'This device has no sync id yet. Call ensureDeviceId() first.',
    )
  }
  const updatedAt = [preferences.sync.lastModifiedAt, preferences.sync.lastSyncedAt].find(
    (t) => typeof t === 'string' && !Number.isNaN(new Date(t).getTime()),
  )
  return {
    deviceId,
    updatedAt: updatedAt ?? new Date(0).toISOString(),
    preferences: migratePreferences(preferences),
  }
}

/** Serialise this device's preferences for transfer to another device. */
export function exportSyncSnapshot(preferences: UserPreferences): string {
  return JSON.stringify({ format: SNAPSHOT_FORMAT, ...toSnapshot(preferences) })
}

/** Parse a snapshot produced by `exportSyncSnapshot` on another device. */
export function parseSyncSnapshot(text: string): PreferenceSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new PreferenceSyncError('INVALID_SNAPSHOT', 'The snapshot is not valid JSON.')
  }
  if (!isPlainObject(parsed) || parsed.format !== SNAPSHOT_FORMAT) {
    throw new PreferenceSyncError('INVALID_SNAPSHOT', 'This is not a preferences sync snapshot.')
  }
  const { deviceId, updatedAt, preferences } = parsed as unknown as PreferenceSnapshot
  return validateSnapshot({ deviceId, updatedAt, preferences }, 'Remote')
}

/** Give a device a stable random sync id (the default `local` is shared by every device). */
export function ensureDeviceId(
  preferences: UserPreferences,
  random: () => string = () =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36),
): UserPreferences {
  if (preferences.sync?.deviceId && preferences.sync.deviceId !== 'local') return preferences
  return { ...preferences, sync: { ...preferences.sync, deviceId: `device-${random()}` } }
}

/** Human-readable value for the conflict UI. */
export function formatPreferenceValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '(not set)'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (Array.isArray(value)) return value.length === 0 ? '(empty)' : `${value.length} item${value.length === 1 ? '' : 's'}`
  if (isPlainObject(value)) return `${Object.keys(value).length} setting${Object.keys(value).length === 1 ? '' : 's'}`
  return String(value)
}
