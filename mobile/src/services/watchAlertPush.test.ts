import { describe, expect, it } from 'vitest'
import { WATCH_ALERT_PUSH_CONFIG } from '../config/pushNotifications'
import {
  InvalidPushPreferenceError,
  buildWatchAlertPayload,
  defaultWatchAlertPushPreferences,
  evaluateOptIn,
  needsRuntimePermission,
  parseWatchAlertPushPreferences,
  selectPushableAlerts,
  updateWatchAlertPushPreferences,
  type WatchAlertEvent,
  type WatchAlertPushPreferences,
} from './watchAlertPush'

const A = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7'
const B = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H'
const NOW = 1_800_000_000_000

const optedIn = (overrides: Partial<WatchAlertPushPreferences> = {}): WatchAlertPushPreferences => ({
  ...defaultWatchAlertPushPreferences(),
  enabled: true,
  consentedAt: NOW - 1000,
  ...overrides,
})

let seq = 0
const alert = (overrides: Partial<WatchAlertEvent> = {}): WatchAlertEvent => ({
  id: `alert-${++seq}`,
  accountAddress: A,
  level: 'warning',
  kind: 'balance_below',
  title: 'Balance below threshold',
  message: 'XLM balance 4 is below 10',
  createdAt: NOW - 10,
  ...overrides,
})

const grantedEnv = {
  platform: 'android',
  androidApiLevel: 34,
  messagingAvailable: true,
  permission: 'granted' as const,
  token: 'fcm-token',
}

describe('watched-account push alerts (#890)', () => {
  describe('primary flow', () => {
    it('is off by default until the user opts in', () => {
      const prefs = defaultWatchAlertPushPreferences()
      expect(prefs.enabled).toBe(false)
      expect(prefs.consentedAt).toBeNull()
      const { toSend, suppressed } = selectPushableAlerts([alert()], prefs, [], NOW)
      expect(toSend).toEqual([])
      expect(suppressed[0].reason).toBe('push_disabled')
    })

    it('opts in when permission is granted and a token is issued', () => {
      expect(evaluateOptIn(grantedEnv)).toEqual({ status: 'enabled', token: 'fcm-token' })
    })

    it('pushes threshold and anomaly alerts for watched accounts', () => {
      const events = [
        alert({ kind: 'balance_below' }),
        alert({ kind: 'anomaly', level: 'critical', title: 'Anomaly', message: 'XLM moved 80%' }),
      ]
      const { toSend, history } = selectPushableAlerts(events, optedIn(), [], NOW)
      expect(toSend.map((p) => p.data.type)).toEqual(['watch_threshold', 'watch_anomaly'])
      expect(toSend[1].priority).toBe('high')
      expect(toSend[0].channelId).toBe(WATCH_ALERT_PUSH_CONFIG.channelId)
      expect(toSend[0].data.channel).toBe(WATCH_ALERT_PUSH_CONFIG.channelId)
      expect(history).toHaveLength(2)
    })

    it('shortens the account address and message for the lock screen', () => {
      const payload = buildWatchAlertPayload(alert({ message: 'x'.repeat(500) }))
      expect(payload.title).toBe(`Balance below threshold · GAAZ…CWN7`)
      expect(payload.body).toHaveLength(140)
    })
  })

  describe('filtering and boundary cases', () => {
    it('applies category, severity and account filters', () => {
      const prefs = optedIn({
        categories: { threshold: true, anomaly: false },
        minLevel: 'warning',
        accounts: [A],
      })
      const events = [
        alert({ id: 'anom', kind: 'anomaly' }),
        alert({ id: 'info', level: 'info' }),
        alert({ id: 'other', accountAddress: B }),
        alert({ id: 'ok' }),
      ]
      const { toSend, suppressed } = selectPushableAlerts(events, prefs, [], NOW)
      expect(toSend.map((p) => p.data.alertId)).toEqual(['ok'])
      expect(Object.fromEntries(suppressed.map((s) => [s.alertId, s.reason]))).toEqual({
        anom: 'category_disabled',
        info: 'below_min_level',
        other: 'account_not_selected',
      })
    })

    it('pushes an alert exactly at the minimum level', () => {
      const { toSend } = selectPushableAlerts([alert({ level: 'critical' })], optedIn({ minLevel: 'critical' }), [], NOW)
      expect(toSend).toHaveLength(1)
    })

    it('dedupes inside the window and allows the same alert right after it', () => {
      const edge = NOW - WATCH_ALERT_PUSH_CONFIG.dedupeWindowMs
      const inside = [{ accountAddress: A, kind: 'balance_below', sentAt: edge + 1 }]
      const atEdge = [{ accountAddress: A, kind: 'balance_below', sentAt: edge }]
      expect(selectPushableAlerts([alert()], optedIn(), inside, NOW).suppressed[0].reason).toBe('duplicate')
      expect(selectPushableAlerts([alert()], optedIn(), atEdge, NOW).toSend).toHaveLength(1)
    })

    it('rate limits each account at the hourly budget', () => {
      const max = WATCH_ALERT_PUSH_CONFIG.maxPushesPerAccountPerHour
      const kinds = ['balance_below', 'balance_above', 'balance_change_pct', 'anomaly']
      const events = Array.from({ length: max + 2 }, (_, i) =>
        alert({ id: `a${i}`, kind: kinds[i % kinds.length], createdAt: NOW - 100 + i }),
      )
      const history = Array.from({ length: max - 2 }, (_, i) => ({
        accountAddress: A,
        kind: `old-${i}`,
        sentAt: NOW - 30 * 60_000,
      }))
      const result = selectPushableAlerts(events, optedIn(), history, NOW)
      expect(result.toSend).toHaveLength(2)
      expect(result.suppressed.some((s) => s.reason === 'rate_limited')).toBe(true)
      // Another account has its own budget.
      expect(selectPushableAlerts([alert({ accountAddress: B })], optedIn(), result.history, NOW).toSend).toHaveLength(1)
    })

    it('drops history older than an hour', () => {
      const old = [{ accountAddress: A, kind: 'x', sentAt: NOW - 61 * 60_000 }]
      expect(selectPushableAlerts([], optedIn(), old, NOW).history).toEqual([])
    })

    it('orders pushes deterministically by time then id', () => {
      const events = [
        alert({ id: 'b', kind: 'balance_above', createdAt: NOW - 5 }),
        alert({ id: 'a', kind: 'anomaly', createdAt: NOW - 5 }),
        alert({ id: 'c', kind: 'balance_below', createdAt: NOW - 50 }),
      ]
      expect(selectPushableAlerts(events, optedIn(), [], NOW).toSend.map((p) => p.data.alertId)).toEqual([
        'c',
        'a',
        'b',
      ])
    })

    it('does not need a runtime permission prompt below Android 13', () => {
      expect(needsRuntimePermission('android', 32)).toBe(false)
      expect(needsRuntimePermission('android', 33)).toBe(true)
      expect(needsRuntimePermission('ios')).toBe(true)
    })

    it('caps explicitly selected accounts', () => {
      const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
      const tooMany = Array.from(
        { length: WATCH_ALERT_PUSH_CONFIG.maxSelectedAccounts + 1 },
        (_, i) => `G${'A'.repeat(53)}${b32[Math.floor(i / 32)]}${b32[i % 32]}`,
      )
      expect(() => updateWatchAlertPushPreferences(optedIn(), { accounts: tooMany })).toThrow(/At most/)
      expect(updateWatchAlertPushPreferences(optedIn(), { accounts: [A, A] }).accounts).toEqual([A])
    })
  })

  describe('failure paths', () => {
    it.each([
      [{ platform: 'web' }, 'unsupported'],
      [{ messagingAvailable: false }, 'unsupported'],
      [{ permission: 'denied' as const }, 'denied'],
      [{ permission: 'blocked' as const }, 'denied'],
      [{ token: null }, 'error'],
    ])('refuses to opt in for %j', (overrides, status) => {
      const result = evaluateOptIn({ ...grantedEnv, ...overrides })
      expect(result.status).toBe(status)
      expect('reason' in result && result.reason).toBeTruthy()
    })

    it.each([
      [{ enabled: 'yes' }, 'enabled'],
      [{ minLevel: 'urgent' }, 'minLevel'],
      [{ accounts: ['not-an-address'] }, 'accounts'],
      [{ accounts: 'some' }, 'accounts'],
      [{ categories: { price: true } }, 'categories'],
      [{ categories: { threshold: false, anomaly: false } }, 'categories'],
      [{ consentedAt: -1 }, 'consentedAt'],
    ])('rejects invalid preference %j', (patch, field) => {
      try {
        updateWatchAlertPushPreferences(optedIn(), patch as never)
        throw new Error('expected an error')
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidPushPreferenceError)
        expect((error as InvalidPushPreferenceError).field).toBe(field)
      }
    })

    it('recovers from corrupt stored preferences without enabling push', () => {
      expect(parseWatchAlertPushPreferences('{not json')).toEqual(defaultWatchAlertPushPreferences())
      expect(parseWatchAlertPushPreferences(42)).toEqual(defaultWatchAlertPushPreferences())
      const tampered = parseWatchAlertPushPreferences({ enabled: true, consentedAt: null, minLevel: 'nope' })
      expect(tampered.enabled).toBe(false)
      expect(tampered.minLevel).toBe(WATCH_ALERT_PUSH_CONFIG.defaultMinLevel)
    })

    it('round-trips valid stored preferences', () => {
      const prefs = optedIn({ minLevel: 'critical', accounts: [B] })
      expect(parseWatchAlertPushPreferences(JSON.stringify(prefs))).toEqual(prefs)
    })

    it('skips malformed alerts and unknown kinds instead of throwing', () => {
      const { toSend, suppressed } = selectPushableAlerts(
        [null, { id: 'x' }, alert({ id: 'bad-addr', accountAddress: 'G123' }), alert({ id: 'k', kind: 'price' })],
        optedIn(),
        [],
        NOW,
      )
      expect(toSend).toEqual([])
      expect(suppressed.map((s) => s.reason)).toEqual(['invalid_alert', 'invalid_alert', 'invalid_alert', 'invalid_alert'])
      expect(() => buildWatchAlertPayload(alert({ kind: 'price' }))).toThrow(InvalidPushPreferenceError)
    })
  })
})
