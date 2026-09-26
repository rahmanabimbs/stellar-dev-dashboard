import { Platform, PermissionsAndroid } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { WATCH_ALERT_PUSH_CONFIG } from '../config/pushNotifications'
import {
  evaluateOptIn,
  needsRuntimePermission,
  parseWatchAlertPushPreferences,
  updateWatchAlertPushPreferences,
  type OptInResult,
  type PermissionState,
  type WatchAlertPushPreferences,
} from './watchAlertPush'

const PUSH_TOKEN_KEY = 'push_token'
const NOTIFICATIONS_ENABLED_KEY = 'notifications_enabled'
const WATCH_ALERT_PUSH_KEY = 'watch_alert_push_prefs'

export type NotificationPriority = 'high' | 'normal' | 'low'

export interface PushNotificationPayload {
  title: string
  body: string
  data?: Record<string, unknown>
  priority?: NotificationPriority
  sound?: string
  badge?: number
  category?: string
}

export type NotificationType =
  | 'transaction_received'
  | 'transaction_sent'
  | 'account_merge'
  | 'trustline_added'
  | 'claimable_balance'
  | 'contract_event'
  | 'network_alert'
  | 'price_alert'
  | 'sync_complete'
  | 'watch_threshold'
  | 'watch_anomaly'
  | 'error'

export interface NotificationChannel {
  id: string
  name: string
  description: string
  enabled: boolean
  types: NotificationType[]
}

export const DEFAULT_CHANNELS: NotificationChannel[] = [
  {
    id: 'transactions',
    name: 'Transactions',
    description: 'Payment and transaction notifications',
    enabled: true,
    types: ['transaction_received', 'transaction_sent', 'account_merge'],
  },
  {
    id: 'trustlines',
    name: 'Trustlines',
    description: 'Trustline and asset notifications',
    enabled: true,
    types: ['trustline_added'],
  },
  {
    id: 'contracts',
    name: 'Contracts',
    description: 'Smart contract event notifications',
    enabled: true,
    types: ['contract_event'],
  },
  {
    id: 'network',
    name: 'Network',
    description: 'Network status and alert notifications',
    enabled: true,
    types: ['network_alert'],
  },
  {
    id: 'prices',
    name: 'Prices',
    description: 'Asset price alert notifications',
    enabled: true,
    types: ['price_alert'],
  },
  {
    // Opt-in only: stays off until the user enables watched-account push.
    id: WATCH_ALERT_PUSH_CONFIG.channelId,
    name: WATCH_ALERT_PUSH_CONFIG.channelName,
    description: WATCH_ALERT_PUSH_CONFIG.channelDescription,
    enabled: false,
    types: ['watch_threshold', 'watch_anomaly'],
  },
  {
    id: 'sync',
    name: 'Sync',
    description: 'Offline sync completion notifications',
    enabled: true,
    types: ['sync_complete'],
  },
  {
    id: 'errors',
    name: 'Errors',
    description: 'Error and failure notifications',
    enabled: true,
    types: ['error'],
  },
]

export async function requestNotificationPermission(): Promise<boolean> {
  return (await requestNotificationPermissionState()) === 'granted'
}

/** Like `requestNotificationPermission`, but distinguishes "denied" from "blocked". */
export async function requestNotificationPermissionState(): Promise<PermissionState> {
  try {
    const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : undefined
    if (!needsRuntimePermission(Platform.OS, apiLevel)) return 'granted'

    if (Platform.OS === 'android') {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      )
      if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted'
      return result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'denied'
    }

    // iOS: Firebase Messaging owns the authorization prompt.
    const messaging = require('@react-native-firebase/messaging').default
    const status = await messaging().requestPermission()
    const { AuthorizationStatus } = require('@react-native-firebase/messaging').default
    if (status === AuthorizationStatus.AUTHORIZED || status === AuthorizationStatus.PROVISIONAL) {
      return 'granted'
    }
    return status === AuthorizationStatus.DENIED ? 'blocked' : 'undetermined'
  } catch {
    return 'denied'
  }
}

function isMessagingAvailable(): boolean {
  try {
    require('@react-native-firebase/messaging')
    return true
  } catch {
    return false
  }
}

export async function getFCMToken(): Promise<string | null> {
  try {
    const messaging = require('@react-native-firebase/messaging').default
    await messaging().registerDeviceForRemoteMessages()
    const token = await messaging().getToken()
    if (token) {
      await AsyncStorage.setItem(PUSH_TOKEN_KEY, token)
    }
    return token
  } catch {
    return null
  }
}

export async function deleteFCMToken(): Promise<void> {
  try {
    const messaging = require('@react-native-firebase/messaging').default
    await messaging().deleteToken()
    await AsyncStorage.removeItem(PUSH_TOKEN_KEY)
  } catch {}
}

export async function getStoredPushToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PUSH_TOKEN_KEY)
  } catch {
    return null
  }
}

export async function isNotificationsEnabled(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(NOTIFICATIONS_ENABLED_KEY)
    return value !== 'false'
  } catch {
    return true
  }
}

export async function setNotificationsEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(NOTIFICATIONS_ENABLED_KEY, enabled ? 'true' : 'false')
  if (!enabled) {
    await deleteFCMToken()
  }
}

export async function getChannels(): Promise<NotificationChannel[]> {
  try {
    const raw = await AsyncStorage.getItem('notification_channels')
    if (raw) return mergeWithDefaultChannels(JSON.parse(raw))
  } catch {}
  return DEFAULT_CHANNELS
}

/**
 * Add channels introduced after the user's settings were saved (e.g. watched
 * account alerts), keeping their saved on/off choices for existing channels.
 */
export function mergeWithDefaultChannels(stored: unknown): NotificationChannel[] {
  if (!Array.isArray(stored)) return DEFAULT_CHANNELS
  const saved = new Map(
    stored
      .filter((c): c is NotificationChannel => !!c && typeof c.id === 'string')
      .map((c) => [c.id, c]),
  )
  return DEFAULT_CHANNELS.map((def) => {
    const prev = saved.get(def.id)
    return prev && typeof prev.enabled === 'boolean' ? { ...def, enabled: prev.enabled } : def
  })
}

// ─── Watched-account alert push (#890) ─────────────────────────────────────────

export async function getWatchAlertPushPreferences(): Promise<WatchAlertPushPreferences> {
  try {
    return parseWatchAlertPushPreferences(await AsyncStorage.getItem(WATCH_ALERT_PUSH_KEY))
  } catch {
    return parseWatchAlertPushPreferences(null)
  }
}

export async function saveWatchAlertPushPreferences(
  patch: Partial<WatchAlertPushPreferences>,
): Promise<WatchAlertPushPreferences> {
  const next = updateWatchAlertPushPreferences(await getWatchAlertPushPreferences(), patch)
  await AsyncStorage.setItem(WATCH_ALERT_PUSH_KEY, JSON.stringify(next))
  return next
}

export interface WatchAlertPushDeps {
  messagingAvailable: () => boolean
  requestPermission: () => Promise<PermissionState>
  getToken: () => Promise<string | null>
}

const defaultWatchAlertPushDeps: WatchAlertPushDeps = {
  messagingAvailable: isMessagingAvailable,
  requestPermission: requestNotificationPermissionState,
  getToken: getFCMToken,
}

/**
 * Opt in to push for watched-account alerts. Asks for permission, registers
 * the device, and only then records consent. On any failure push stays off.
 */
export async function enableWatchAlertPush(
  overrides: Partial<WatchAlertPushDeps> = {},
): Promise<OptInResult> {
  const deps = { ...defaultWatchAlertPushDeps, ...overrides }
  const messagingAvailable = deps.messagingAvailable()
  const permission = messagingAvailable ? await deps.requestPermission() : 'denied'
  const token = messagingAvailable && permission === 'granted' ? await deps.getToken() : null
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : undefined

  const result = evaluateOptIn({
    platform: Platform.OS,
    androidApiLevel: apiLevel,
    messagingAvailable,
    permission,
    token,
  })

  if (result.status === 'enabled') {
    await saveWatchAlertPushPreferences({ enabled: true, consentedAt: Date.now() })
    await toggleChannel(WATCH_ALERT_PUSH_CONFIG.channelId, true)
  }
  return result
}

/** Opt out. Keeps the device token, since other channels may still use it. */
export async function disableWatchAlertPush(): Promise<WatchAlertPushPreferences> {
  const prefs = await saveWatchAlertPushPreferences({ enabled: false })
  await toggleChannel(WATCH_ALERT_PUSH_CONFIG.channelId, false)
  return prefs
}

export async function saveChannels(channels: NotificationChannel[]): Promise<void> {
  await AsyncStorage.setItem('notification_channels', JSON.stringify(channels))
}

export async function toggleChannel(channelId: string, enabled: boolean): Promise<NotificationChannel[]> {
  const channels = await getChannels()
  const updated = channels.map((ch) =>
    ch.id === channelId ? { ...ch, enabled } : ch,
  )
  await saveChannels(updated)
  return updated
}

export function buildNotificationPayload(
  type: NotificationType,
  data: Record<string, unknown>,
): PushNotificationPayload {
  const payloads: Record<NotificationType, PushNotificationPayload> = {
    transaction_received: {
      title: 'Payment Received',
      body: `You received ${data.amount || ''} ${data.asset || 'XLM'}`,
      data,
      priority: 'high',
      category: 'transaction',
    },
    transaction_sent: {
      title: 'Payment Sent',
      body: `You sent ${data.amount || ''} ${data.asset || 'XLM'}`,
      data,
      priority: 'normal',
      category: 'transaction',
    },
    account_merge: {
      title: 'Account Merged',
      body: 'Your account has been merged',
      data,
      priority: 'high',
      category: 'account',
    },
    trustline_added: {
      title: 'Trustline Added',
      body: `Trustline added for ${data.asset_code || 'unknown'}`,
      data,
      priority: 'normal',
      category: 'trustline',
    },
    claimable_balance: {
      title: 'Claimable Balance',
      body: `You have a claimable balance of ${data.amount || ''} ${data.asset || 'XLM'}`,
      data,
      priority: 'normal',
      category: 'balance',
    },
    contract_event: {
      title: 'Contract Event',
      body: `Contract ${data.contract_id ? String(data.contract_id).slice(0, 8) + '\u2026' : 'unknown'} triggered an event`,
      data,
      priority: 'normal',
      category: 'contract',
    },
    network_alert: {
      title: 'Network Alert',
      body: (data.message as string) || 'Network status changed',
      data,
      priority: 'high',
      category: 'network',
    },
    price_alert: {
      title: 'Price Alert',
      body: `${data.asset || 'XLM'} is now ${data.price || 'unknown'}`,
      data,
      priority: 'normal',
      category: 'price',
    },
    sync_complete: {
      title: 'Sync Complete',
      body: 'Offline data has been synchronized',
      data,
      priority: 'low',
      category: 'sync',
    },
    watch_threshold: {
      title: 'Watched Account Alert',
      body: (data.message as string) || 'A watch rule threshold was crossed',
      data,
      priority: data.level === 'critical' ? 'high' : 'normal',
      category: 'watch',
    },
    watch_anomaly: {
      title: 'Unusual Account Activity',
      body: (data.message as string) || 'Anomalous balance movement detected',
      data,
      priority: 'high',
      category: 'watch',
    },
    error: {
      title: 'Error',
      body: (data.message as string) || 'An error occurred',
      data,
      priority: 'high',
      category: 'error',
    },
  }

  return payloads[type] || payloads.error
}

export function setupForegroundHandler(): () => void {
  try {
    const messaging = require('@react-native-firebase/messaging').default
    const unsubscribe = messaging().onMessage(async (remoteMessage: any) => {
      const { notification, data } = remoteMessage
      if (notification) {
        const { default: notifee } = require('@notifee/react-native')
        const channelId = (data?.channel as string) || 'default'
        await notifee.displayNotification({
          title: notification.title,
          body: notification.body,
          android: {
            channelId,
            smallIcon: 'ic_notification',
          },
          ios: {
            sound: 'default',
          },
        })
      }
    })
    return unsubscribe
  } catch {
    return () => {}
  }
}

export function setupBackgroundHandler(): void {
  try {
    const messaging = require('@react-native-firebase/messaging').default
    messaging().setBackgroundMessageHandler(async (remoteMessage: any) => {
      const { data } = remoteMessage
      if (data?.type) {
        const { useStore } = require('../store')
        const store = useStore.getState()
        store.addNotificationHistory({
          id: String(data.id || Date.now()),
          type: data.type as string,
          title: data.title || 'Notification',
          body: data.body || '',
          data,
        })
      }
    })
  } catch {}
}

export function onTokenRefresh(callback: (token: string) => void): () => void {
  try {
    const messaging = require('@react-native-firebase/messaging').default
    return messaging().onTokenRefresh(callback)
  } catch {
    return () => {}
  }
}
