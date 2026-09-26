/**
 * Push notification configuration for watched-account alerts (#890).
 *
 * Kept free of React Native imports so it can be unit tested from the web
 * workspace. See docs/guides/mobile-push-alerts.md.
 */

export const WATCH_ALERT_PUSH_CONFIG = {
  /** Android notification channel id used for watched-account alerts. */
  channelId: 'watch_alerts',
  channelName: 'Watched account alerts',
  channelDescription: 'Threshold and anomaly alerts for accounts on your watchlist',
  /** Push is strictly opt-in: nothing is sent until the user enables it. */
  defaultEnabled: false,
  /** Lowest severity pushed by default. `info` alerts stay in-app. */
  defaultMinLevel: 'warning' as const,
  /** Identical alerts for the same account + rule inside this window are dropped. */
  dedupeWindowMs: 15 * 60_000,
  /** Per-account push budget, to avoid flooding during volatile markets. */
  maxPushesPerAccountPerHour: 6,
  /** Upper bound on explicitly selected accounts (mirrors the watch system's scale target). */
  maxSelectedAccounts: 100,
  /** Platforms where remote push is supported. */
  supportedPlatforms: ['ios', 'android'] as const,
  /** Android 13 (API 33) introduced the runtime POST_NOTIFICATIONS permission. */
  androidRuntimePermissionApiLevel: 33,
} as const

export type SupportedPushPlatform = (typeof WATCH_ALERT_PUSH_CONFIG.supportedPlatforms)[number]
