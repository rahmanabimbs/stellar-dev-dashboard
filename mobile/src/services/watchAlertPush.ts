/**
 * Watched-account push alerts (#890)
 *
 * Pure logic for opting in to mobile push for threshold and anomaly alerts on
 * watched accounts. Platform wiring (permissions, FCM, storage) lives in
 * `notifications.ts`; everything here is deterministic and unit tested.
 */

import { WATCH_ALERT_PUSH_CONFIG } from '../config/pushNotifications'

export type WatchAlertLevel = 'info' | 'warning' | 'critical'
export type WatchAlertCategory = 'threshold' | 'anomaly'

const LEVEL_RANK: Record<WatchAlertLevel, number> = { info: 0, warning: 1, critical: 2 }
const LEVELS = Object.keys(LEVEL_RANK) as WatchAlertLevel[]
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/

/** Alert emitted by the account watch system (web `RiskAlert` shape). */
export interface WatchAlertEvent {
  id: string
  accountAddress: string
  level: WatchAlertLevel
  /** `balance_below` | `balance_above` | `balance_change_pct` | `anomaly` */
  kind: string
  title: string
  message: string
  createdAt: number
}

export interface WatchAlertPushPreferences {
  enabled: boolean
  /** Epoch ms when the user opted in; null when they never have. */
  consentedAt: number | null
  categories: Record<WatchAlertCategory, boolean>
  minLevel: WatchAlertLevel
  /** `'all'` for every watched account, or an explicit list of G-addresses. */
  accounts: 'all' | string[]
}

export interface WatchAlertPushPayload {
  title: string
  body: string
  priority: 'high' | 'normal'
  channelId: string
  category: WatchAlertCategory
  data: {
    type: 'watch_threshold' | 'watch_anomaly'
    /** Read by the foreground handler to pick the Android channel. */
    channel: string
    alertId: string
    accountAddress: string
    level: WatchAlertLevel
    kind: string
  }
}

export class InvalidPushPreferenceError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(message)
    this.name = 'InvalidPushPreferenceError'
    this.field = field
  }
}

// ─── Preferences ──────────────────────────────────────────────────────────────

export function defaultWatchAlertPushPreferences(): WatchAlertPushPreferences {
  return {
    enabled: WATCH_ALERT_PUSH_CONFIG.defaultEnabled,
    consentedAt: null,
    categories: { threshold: true, anomaly: true },
    minLevel: WATCH_ALERT_PUSH_CONFIG.defaultMinLevel,
    accounts: 'all',
  }
}

export function isValidStellarAddress(value: unknown): value is string {
  return typeof value === 'string' && STELLAR_ADDRESS.test(value)
}

/**
 * Validate and apply a user-supplied change. Throws `InvalidPushPreferenceError`
 * naming the offending field, so the UI can show a precise message.
 */
export function updateWatchAlertPushPreferences(
  current: WatchAlertPushPreferences,
  patch: Partial<WatchAlertPushPreferences>,
): WatchAlertPushPreferences {
  if (!patch || typeof patch !== 'object') {
    throw new InvalidPushPreferenceError('patch', 'Preference update must be an object.')
  }
  const next: WatchAlertPushPreferences = {
    ...current,
    categories: { ...current.categories },
  }

  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') {
      throw new InvalidPushPreferenceError('enabled', '`enabled` must be true or false.')
    }
    next.enabled = patch.enabled
  }
  if ('consentedAt' in patch) {
    const v = patch.consentedAt
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      throw new InvalidPushPreferenceError('consentedAt', '`consentedAt` must be a timestamp or null.')
    }
    next.consentedAt = v ?? null
  }
  if ('categories' in patch) {
    const cats = patch.categories
    if (!cats || typeof cats !== 'object') {
      throw new InvalidPushPreferenceError('categories', '`categories` must be an object.')
    }
    for (const [key, value] of Object.entries(cats)) {
      if (key !== 'threshold' && key !== 'anomaly') {
        throw new InvalidPushPreferenceError('categories', `Unknown alert category "${key}".`)
      }
      if (typeof value !== 'boolean') {
        throw new InvalidPushPreferenceError('categories', `Category "${key}" must be true or false.`)
      }
      next.categories[key] = value
    }
  }
  if ('minLevel' in patch) {
    if (!LEVELS.includes(patch.minLevel as WatchAlertLevel)) {
      throw new InvalidPushPreferenceError('minLevel', `\`minLevel\` must be one of ${LEVELS.join(', ')}.`)
    }
    next.minLevel = patch.minLevel as WatchAlertLevel
  }
  if ('accounts' in patch) {
    const accounts = patch.accounts
    if (accounts === 'all') {
      next.accounts = 'all'
    } else if (Array.isArray(accounts)) {
      const invalid = accounts.filter((a) => !isValidStellarAddress(a))
      if (invalid.length > 0) {
        throw new InvalidPushPreferenceError('accounts', `Invalid Stellar address: ${String(invalid[0])}`)
      }
      const unique = [...new Set(accounts)]
      if (unique.length > WATCH_ALERT_PUSH_CONFIG.maxSelectedAccounts) {
        throw new InvalidPushPreferenceError(
          'accounts',
          `At most ${WATCH_ALERT_PUSH_CONFIG.maxSelectedAccounts} accounts can be selected.`,
        )
      }
      next.accounts = unique
    } else {
      throw new InvalidPushPreferenceError('accounts', '`accounts` must be "all" or a list of addresses.')
    }
  }

  if (next.enabled && !next.categories.threshold && !next.categories.anomaly) {
    throw new InvalidPushPreferenceError('categories', 'Enable at least one alert category.')
  }
  return next
}

/**
 * Parse stored preferences. Never throws: corrupt or outdated data falls back
 * to defaults field by field, and push stays off unless consent was recorded.
 */
export function parseWatchAlertPushPreferences(raw: unknown): WatchAlertPushPreferences {
  const defaults = defaultWatchAlertPushPreferences()
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return defaults
    }
  }
  if (!value || typeof value !== 'object') return defaults

  const input = value as Record<string, unknown>
  let prefs = defaults
  for (const key of ['consentedAt', 'minLevel', 'accounts', 'categories'] as const) {
    if (!(key in input)) continue
    try {
      prefs = updateWatchAlertPushPreferences(prefs, { [key]: input[key] } as Partial<WatchAlertPushPreferences>)
    } catch {
      /* keep the default for this field */
    }
  }
  const hasCategory = prefs.categories.threshold || prefs.categories.anomaly
  prefs.enabled = input.enabled === true && prefs.consentedAt !== null && hasCategory
  return prefs
}

// ─── Opt-in ───────────────────────────────────────────────────────────────────

export type PermissionState = 'granted' | 'denied' | 'blocked' | 'undetermined'

export interface OptInEnvironment {
  platform: string
  /** Android API level; ignored on iOS. */
  androidApiLevel?: number
  /** Whether @react-native-firebase/messaging loaded. */
  messagingAvailable: boolean
  permission: PermissionState
  token: string | null
}

export type OptInResult =
  | { status: 'enabled'; token: string }
  | { status: 'unsupported' | 'denied' | 'error'; reason: string }

/** Only Android 13+ has a runtime notification permission. */
export function needsRuntimePermission(platform: string, androidApiLevel?: number): boolean {
  if (platform === 'ios') return true
  if (platform !== 'android') return false
  return (androidApiLevel ?? 0) >= WATCH_ALERT_PUSH_CONFIG.androidRuntimePermissionApiLevel
}

export function evaluateOptIn(env: OptInEnvironment): OptInResult {
  if (!(WATCH_ALERT_PUSH_CONFIG.supportedPlatforms as readonly string[]).includes(env.platform)) {
    return { status: 'unsupported', reason: `Push notifications are not supported on ${env.platform}.` }
  }
  if (!env.messagingAvailable) {
    return {
      status: 'unsupported',
      reason: 'Push messaging is not available in this build (Firebase Messaging is missing).',
    }
  }
  if (env.permission === 'blocked') {
    return {
      status: 'denied',
      reason: 'Notifications are blocked for this app. Enable them in system settings.',
    }
  }
  if (env.permission !== 'granted') {
    return { status: 'denied', reason: 'Notification permission was not granted.' }
  }
  if (!env.token) {
    return { status: 'error', reason: 'Could not register this device for push. Try again later.' }
  }
  return { status: 'enabled', token: env.token }
}

// ─── Alert selection ──────────────────────────────────────────────────────────

export function categoryOf(kind: string): WatchAlertCategory | null {
  if (kind === 'anomaly') return 'anomaly'
  if (kind === 'balance_below' || kind === 'balance_above' || kind === 'balance_change_pct') {
    return 'threshold'
  }
  return null
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

export function buildWatchAlertPayload(event: WatchAlertEvent): WatchAlertPushPayload {
  const category = categoryOf(event.kind)
  if (!category) {
    throw new InvalidPushPreferenceError('kind', `Unsupported watch alert kind "${event.kind}".`)
  }
  return {
    title: `${event.title} · ${shortAddress(event.accountAddress)}`,
    // Lock-screen text: keep it short and free of anything sensitive.
    body: event.message.length > 140 ? `${event.message.slice(0, 139)}…` : event.message,
    priority: event.level === 'critical' ? 'high' : 'normal',
    channelId: WATCH_ALERT_PUSH_CONFIG.channelId,
    category,
    data: {
      type: category === 'anomaly' ? 'watch_anomaly' : 'watch_threshold',
      channel: WATCH_ALERT_PUSH_CONFIG.channelId,
      alertId: event.id,
      accountAddress: event.accountAddress,
      level: event.level,
      kind: event.kind,
    },
  }
}

/** Record of a push already sent, used for dedupe and rate limiting. */
export interface PushHistoryEntry {
  accountAddress: string
  kind: string
  sentAt: number
}

export type SuppressionReason =
  | 'push_disabled'
  | 'invalid_alert'
  | 'category_disabled'
  | 'below_min_level'
  | 'account_not_selected'
  | 'duplicate'
  | 'rate_limited'

export interface PushSelection {
  toSend: WatchAlertPushPayload[]
  suppressed: { alertId: string; reason: SuppressionReason }[]
  /** History including the pushes selected this round. Persist it. */
  history: PushHistoryEntry[]
}

function isValidEvent(e: unknown): e is WatchAlertEvent {
  const ev = e as WatchAlertEvent
  return (
    !!ev &&
    typeof ev.id === 'string' &&
    isValidStellarAddress(ev.accountAddress) &&
    ev.level in LEVEL_RANK &&
    typeof ev.title === 'string' &&
    typeof ev.message === 'string' &&
    Number.isFinite(ev.createdAt)
  )
}

/**
 * Decide which alerts become pushes. Deterministic for a given input: alerts
 * are processed oldest first, and every dropped alert has a reason.
 */
export function selectPushableAlerts(
  events: readonly unknown[],
  prefs: WatchAlertPushPreferences,
  history: readonly PushHistoryEntry[] = [],
  now: number = Date.now(),
): PushSelection {
  const hourAgo = now - 60 * 60_000
  // Keep only what dedupe and rate limiting can still look at.
  const retainFrom = now - Math.max(60 * 60_000, WATCH_ALERT_PUSH_CONFIG.dedupeWindowMs)
  const kept = history.filter((h) => Number.isFinite(h?.sentAt) && h.sentAt > retainFrom)
  const selection: PushSelection = { toSend: [], suppressed: [], history: kept }

  const valid: WatchAlertEvent[] = []
  for (const e of events) {
    if (isValidEvent(e)) valid.push(e)
    else selection.suppressed.push({ alertId: String((e as WatchAlertEvent)?.id ?? 'unknown'), reason: 'invalid_alert' })
  }
  valid.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))

  const selected = prefs.accounts === 'all' ? null : new Set(prefs.accounts)

  for (const event of valid) {
    const suppress = (reason: SuppressionReason) => selection.suppressed.push({ alertId: event.id, reason })
    const category = categoryOf(event.kind)

    if (!prefs.enabled || prefs.consentedAt === null) { suppress('push_disabled'); continue }
    if (!category) { suppress('invalid_alert'); continue }
    if (!prefs.categories[category]) { suppress('category_disabled'); continue }
    if (LEVEL_RANK[event.level] < LEVEL_RANK[prefs.minLevel]) { suppress('below_min_level'); continue }
    if (selected && !selected.has(event.accountAddress)) { suppress('account_not_selected'); continue }

    const forAccount = selection.history.filter((h) => h.accountAddress === event.accountAddress)
    if (
      forAccount.some(
        (h) => h.kind === event.kind && h.sentAt > now - WATCH_ALERT_PUSH_CONFIG.dedupeWindowMs,
      )
    ) {
      suppress('duplicate')
      continue
    }
    if (
      forAccount.filter((h) => h.sentAt > hourAgo).length >= WATCH_ALERT_PUSH_CONFIG.maxPushesPerAccountPerHour
    ) {
      suppress('rate_limited')
      continue
    }

    selection.toSend.push(buildWatchAlertPayload(event))
    selection.history.push({ accountAddress: event.accountAddress, kind: event.kind, sentAt: now })
  }

  return selection
}
