import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  store: new Map<string, string>(),
  platform: { OS: 'android', Version: 34 },
  androidResult: 'granted',
  token: 'fcm-token' as string | null,
}))

vi.mock('react-native', () => ({
  Platform: env.platform,
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: 'post' },
    RESULTS: { GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again' },
    request: vi.fn(async () => env.androidResult),
  },
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => env.store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => void env.store.set(k, v)),
    removeItem: vi.fn(async (k: string) => void env.store.delete(k)),
  },
}))

import {
  DEFAULT_CHANNELS,
  disableWatchAlertPush,
  enableWatchAlertPush as enableWithPlatform,
  getChannels,
  getWatchAlertPushPreferences,
  mergeWithDefaultChannels,
  requestNotificationPermissionState,
} from './notifications'
import { WATCH_ALERT_PUSH_CONFIG } from '../config/pushNotifications'

// Firebase is loaded lazily with require(), which vi.mock cannot intercept, so
// the messaging pieces are injected. Permission handling uses the real code.
const enableWatchAlertPush = () =>
  enableWithPlatform({
    messagingAvailable: () => true,
    requestPermission: requestNotificationPermissionState,
    getToken: async () => env.token,
  })

const channelEnabled = async () =>
  (await getChannels()).find((c) => c.id === WATCH_ALERT_PUSH_CONFIG.channelId)?.enabled

describe('mobile watched-account push wiring (#890)', () => {
  beforeEach(() => {
    env.store.clear()
    env.platform.OS = 'android'
    env.platform.Version = 34
    env.androidResult = 'granted'
    env.token = 'fcm-token'
  })

  it('ships the watched-alerts channel disabled by default', () => {
    const channel = DEFAULT_CHANNELS.find((c) => c.id === WATCH_ALERT_PUSH_CONFIG.channelId)
    expect(channel?.enabled).toBe(false)
    expect(channel?.types).toEqual(['watch_threshold', 'watch_anomaly'])
  })

  it('opts in, records consent and enables the channel', async () => {
    const result = await enableWatchAlertPush()
    expect(result).toEqual({ status: 'enabled', token: 'fcm-token' })
    const prefs = await getWatchAlertPushPreferences()
    expect(prefs.enabled).toBe(true)
    expect(prefs.consentedAt).toEqual(expect.any(Number))
    expect(await channelEnabled()).toBe(true)
  })

  it('opts out and disables the channel', async () => {
    await enableWatchAlertPush()
    const prefs = await disableWatchAlertPush()
    expect(prefs.enabled).toBe(false)
    expect(await channelEnabled()).toBe(false)
  })

  it('leaves push off when permission is permanently denied', async () => {
    env.androidResult = 'never_ask_again'
    const result = await enableWatchAlertPush()
    expect(result.status).toBe('denied')
    expect((await getWatchAlertPushPreferences()).enabled).toBe(false)
    expect(await channelEnabled()).toBe(false)
  })

  it('leaves push off when no device token is issued', async () => {
    env.token = null
    expect((await enableWatchAlertPush()).status).toBe('error')
    expect((await getWatchAlertPushPreferences()).enabled).toBe(false)
  })

  it('skips the prompt on Android 12 and below', async () => {
    env.platform.Version = 31
    env.androidResult = 'denied'
    expect((await enableWatchAlertPush()).status).toBe('enabled')
  })

  it('reports unsupported when Firebase Messaging is not bundled', async () => {
    // No override: the real lazy require fails outside a React Native build.
    const result = await enableWithPlatform()
    expect(result.status).toBe('unsupported')
    expect((await getWatchAlertPushPreferences()).enabled).toBe(false)
  })

  it('adds new default channels to settings saved before this release', () => {
    const legacy = [{ id: 'transactions', enabled: false }, { id: 'removed', enabled: true }]
    const merged = mergeWithDefaultChannels(legacy)
    expect(merged.map((c) => c.id)).toEqual(DEFAULT_CHANNELS.map((c) => c.id))
    expect(merged.find((c) => c.id === 'transactions')?.enabled).toBe(false)
    expect(merged.find((c) => c.id === WATCH_ALERT_PUSH_CONFIG.channelId)?.enabled).toBe(false)
    expect(mergeWithDefaultChannels('garbage')).toEqual(DEFAULT_CHANNELS)
  })
})
