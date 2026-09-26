# Mobile push alerts for watched accounts

The mobile app can send push notifications when a watched account crosses a
watch-rule threshold or shows anomalous balance movement. Push is **opt-in**:
nothing is sent until the user turns it on.

## For users

1. Open **Settings → Watched Account Alerts**.
2. Turn on **Push alerts**. The OS asks for notification permission if needed.
3. Choose which alerts to receive:
   - **Threshold alerts**: `balance_below`, `balance_above`, and `balance_change_pct` watch rules.
   - **Anomaly alerts**: large balance swings flagged by the watch system.
   - **Minimum severity**: tap to cycle `info` → `warning` → `critical`. The default is
     `warning`, so `info` alerts stay in-app only.

Turning the switch off stops watched-account pushes straight away. Other
notification channels are not affected.

If the switch turns itself back off, the app shows why:

| Message                                       | Cause                                                    | Fix                                                                             |
| --------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Notifications are blocked for this app        | Permission was permanently denied                        | Enable notifications for the app in system settings, then try again.            |
| Notification permission was not granted       | The permission prompt was dismissed                      | Toggle again to re-prompt.                                                      |
| Push messaging is not available in this build | The build does not include Firebase Messaging            | Use an official build. Development builds without Firebase cannot receive push. |
| Push notifications are not supported on …     | Running on an unsupported platform                       | Push works on iOS and Android only.                                             |
| Could not register this device for push       | No FCM token was issued (offline, Play Services missing) | Reconnect and try again.                                                        |

## Delivery rules

These rules live in
[`mobile/src/services/watchAlertPush.ts`](../../mobile/src/services/watchAlertPush.ts).
The limits come from
[`mobile/src/config/pushNotifications.ts`](../../mobile/src/config/pushNotifications.ts).

`selectPushableAlerts(events, prefs, history, now)` returns the pushes to send,
every suppressed alert with a reason, and the updated history to persist.
Alerts are processed oldest first (ties broken by id), so the result is
deterministic.

| Rule                                                     | Default    | Suppression reason     |
| -------------------------------------------------------- | ---------- | ---------------------- |
| Push must be enabled with recorded consent               | off        | `push_disabled`        |
| Alert kind must map to a category and pass validation    | —          | `invalid_alert`        |
| Category must be enabled                                 | both on    | `category_disabled`    |
| Severity at or above the minimum                         | `warning`  | `below_min_level`      |
| Account in the selected list (or `all`)                  | `all`      | `account_not_selected` |
| Same account and alert kind not pushed within the window | 15 minutes | `duplicate`            |
| Per-account budget per rolling hour                      | 6 pushes   | `rate_limited`         |

`critical` alerts and anomalies are sent with high priority. Everything else is
sent with normal priority.

### Payload

```jsonc
{
  "title": "Balance below threshold · GAAZ…CWN7",
  "body": "XLM balance 4 is below 10", // truncated to 140 characters
  "priority": "normal",
  "channelId": "watch_alerts",
  "category": "threshold",
  "data": {
    "type": "watch_threshold", // or "watch_anomaly"
    "channel": "watch_alerts", // read by the foreground handler
    "alertId": "alert-…",
    "accountAddress": "G…",
    "level": "warning",
    "kind": "balance_below",
  },
}
```

## For developers

### Opting in from code

```ts
import {
  enableWatchAlertPush,
  disableWatchAlertPush,
  saveWatchAlertPushPreferences,
} from '../services/notifications';

const result = await enableWatchAlertPush();
if (result.status !== 'enabled') showError(result.reason); // 'denied' | 'unsupported' | 'error'

await saveWatchAlertPushPreferences({ minLevel: 'critical', accounts: ['G…'] });
```

`enableWatchAlertPush` records consent (`consentedAt`) only after permission is
granted **and** a device token is issued. On any failure, push stays off.

`saveWatchAlertPushPreferences` throws `InvalidPushPreferenceError` with a
`field` property for invalid input: a non-boolean flag, an unknown severity or
category, a malformed Stellar address, more than 100 selected accounts, or
disabling both categories while push is on.

### Sending from a server

The app registers the device with Firebase Cloud Messaging. The service that
evaluates watch rules must:

1. Run `selectPushableAlerts` (or an equivalent) with the user's stored preferences
   and push history.
2. Send each payload as an FCM message with `data.channel = "watch_alerts"`, so
   Android routes it to the watched-alerts channel.
3. Persist the returned `history`, so dedupe and rate limits survive restarts.

### Tests

```bash
pnpm exec vitest run --config vitest.config.js mobile/src/services
```

## Compatibility

| Platform              | Notes                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Android 13+ (API 33+) | Runtime `POST_NOTIFICATIONS` prompt. "Don't ask again" shows as _blocked_.                       |
| Android 12 and below  | No runtime prompt. Notifications are allowed unless disabled in system settings.                 |
| iOS                   | Permission is requested through Firebase Messaging. Provisional authorization counts as granted. |
| Web dashboard         | Not covered. Browser notifications use the existing in-app and browser alert channels.           |

## Migration

- New installs and existing users start with watched-account push **off**.
  Nobody is opted in automatically.
- Notification channel settings saved before this release are merged with the new
  defaults when loaded. Existing on/off choices are kept, and the new
  `watch_alerts` channel starts disabled.
- Preferences are stored under the AsyncStorage key `watch_alert_push_prefs`.
  Corrupt or tampered values fall back to defaults, and push is only treated as on
  when consent was recorded.

## Security and privacy

- Lock-screen text shows a shortened address (`GAAZ…CWN7`) and the alert message.
  It never includes secret keys, balances beyond the alert text, or transaction
  envelopes.
- The payload carries the full public address in `data` so tapping the
  notification can open the account. Public addresses are not secret, but they do
  link the device to the watched accounts. Tell users this in your privacy notice.
- Opting out stops pushes but keeps the FCM token, because other channels may use
  it. Turning off **Enable Notifications** deletes the token.
