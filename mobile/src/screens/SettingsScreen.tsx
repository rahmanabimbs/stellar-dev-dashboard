import React, { useEffect, useState } from 'react'
import {
  View,
  Text,
  ScrollView,
  Switch,
  StyleSheet,
  Alert,
  TouchableOpacity,
} from 'react-native'
import { useStore } from '../store'
import { NETWORKS, type NetworkName } from '../services/stellar'
import {
  isBiometricsAvailable,
  isBiometricsEnabled,
  setBiometricsEnabled,
  authenticateWithBiometrics,
  getBiometricType,
  type BiometryType,
} from '../services/biometrics'
import {
  isNotificationsEnabled,
  setNotificationsEnabled,
  getFCMToken,
  getChannels,
  toggleChannel,
  getWatchAlertPushPreferences,
  saveWatchAlertPushPreferences,
  enableWatchAlertPush,
  disableWatchAlertPush,
  type NotificationChannel,
} from '../services/notifications'
import {
  InvalidPushPreferenceError,
  type WatchAlertLevel,
  type WatchAlertPushPreferences,
} from '../services/watchAlertPush'
import { WATCH_ALERT_PUSH_CONFIG } from '../config/pushNotifications'
import { colors, radii, spacing, typography } from '../theme'
import Card from '../components/Card'
import Button from '../components/Button'

export default function SettingsScreen() {
  const network = useStore((s) => s.network)
  const setNetwork = useStore((s) => s.setNetwork)
  const biometricsPassed = useStore((s) => s.biometricsPassed)
  const setBiometricsPassed = useStore((s) => s.setBiometricsPassed)
  const connectedAddress = useStore((s) => s.connectedAddress)
  const setConnectedAddress = useStore((s) => s.setConnectedAddress)

  const [bioAvailable, setBioAvailable] = useState(false)
  const [bioEnabled, setBioEnabled] = useState(false)
  const [bioType, setBioType] = useState<BiometryType>('None')
  const [notifEnabled, setNotifEnabled] = useState(true)
  const [channels, setChannels] = useState<NotificationChannel[]>([])
  const [pushToken, setPushTokenLocal] = useState<string | null>(null)
  const [watchPush, setWatchPush] = useState<WatchAlertPushPreferences | null>(null)
  const [watchPushBusy, setWatchPushBusy] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [])

  async function loadSettings() {
    const { available, biometryType } = await isBiometricsAvailable()
    setBioAvailable(available)
    setBioType(biometryType)
    setBioEnabled(await isBiometricsEnabled())
    setNotifEnabled(await isNotificationsEnabled())

    const notifChannels = await getChannels()
    setChannels(notifChannels)
    setWatchPush(await getWatchAlertPushPreferences())

    const token = await getFCMToken()
    setPushTokenLocal(token)
  }

  async function toggleBiometrics(value: boolean) {
    if (value) {
      const success = await authenticateWithBiometrics(
        'Enable biometric authentication',
      )
      if (success) {
        await setBiometricsEnabled(true)
        setBiometricsPassed(true)
        setBioEnabled(true)
        useStore.getState().setBiometricsEnabled(true)
      }
    } else {
      await setBiometricsEnabled(false)
      setBiometricsPassed(false)
      setBioEnabled(false)
      useStore.getState().setBiometricsEnabled(false)
    }
  }

  async function toggleNotifications(value: boolean) {
    await setNotificationsEnabled(value)
    setNotifEnabled(value)
    if (value) {
      const token = await getFCMToken()
      setPushTokenLocal(token)
      if (token) useStore.getState().setPushToken(token)
    } else {
      setPushTokenLocal(null)
      useStore.getState().setPushToken(null)
    }
  }

  async function handleToggleChannel(channelId: string, enabled: boolean) {
    const updated = await toggleChannel(channelId, enabled)
    setChannels(updated)
  }

  async function toggleWatchPush(value: boolean) {
    setWatchPushBusy(true)
    try {
      if (value) {
        const result = await enableWatchAlertPush()
        if (result.status !== 'enabled') {
          Alert.alert('Push alerts not enabled', result.reason)
        } else {
          setNotifEnabled(true)
          setPushTokenLocal(result.token)
          useStore.getState().setPushToken(result.token)
        }
      } else {
        await disableWatchAlertPush()
      }
      setWatchPush(await getWatchAlertPushPreferences())
      setChannels(await getChannels())
    } finally {
      setWatchPushBusy(false)
    }
  }

  async function updateWatchPush(patch: Partial<WatchAlertPushPreferences>) {
    try {
      setWatchPush(await saveWatchAlertPushPreferences(patch))
    } catch (error) {
      if (error instanceof InvalidPushPreferenceError) {
        Alert.alert('Invalid setting', error.message)
      } else {
        throw error
      }
    }
  }

  function cycleWatchPushLevel() {
    const levels: WatchAlertLevel[] = ['info', 'warning', 'critical']
    const current = levels.indexOf(watchPush?.minLevel ?? WATCH_ALERT_PUSH_CONFIG.defaultMinLevel)
    updateWatchPush({ minLevel: levels[(current + 1) % levels.length] })
  }

  function handleNetworkChange() {
    const options: NetworkName[] = ['testnet', 'mainnet', 'futurenet']
    const current = options.indexOf(network)
    const next = options[(current + 1) % options.length]
    setNetwork(next)
  }

  function handleDisconnect() {
    Alert.alert('Disconnect', 'Are you sure you want to disconnect?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => {
          setConnectedAddress(null)
          useStore.getState().setAccountData(null as any)
          useStore.getState().setTransactions([])
          useStore.getState().setOperations([])
        },
      },
    ])
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.screenTitle}>Settings</Text>

        <Card title="Network">
          <TouchableOpacity onPress={handleNetworkChange}>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Current Network</Text>
              <Text style={styles.settingValue}>
                {NETWORKS[network].name}
              </Text>
            </View>
          </TouchableOpacity>
          <Text style={styles.hint}>Tap to switch between Testnet, Mainnet, Futurenet</Text>
        </Card>

        {bioAvailable && (
          <Card title="Biometrics">
            <View style={styles.settingRow}>
              <View>
                <Text style={styles.settingLabel}>
                  {bioType === 'FaceID' ? 'Face ID' : bioType === 'TouchID' ? 'Touch ID' : 'Biometrics'}
                </Text>
                <Text style={styles.settingHint}>
                  {bioEnabled ? 'Enabled' : 'Disabled'}
                </Text>
              </View>
              <Switch
                value={bioEnabled}
                onValueChange={toggleBiometrics}
                trackColor={{ false: colors.border.default, true: colors.cyan }}
                thumbColor={bioEnabled ? colors.text.primary : colors.text.muted}
              />
            </View>
          </Card>
        )}

        <Card title="Push Notifications">
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Enable Notifications</Text>
            <Switch
              value={notifEnabled}
              onValueChange={toggleNotifications}
              trackColor={{ false: colors.border.default, true: colors.cyan }}
              thumbColor={notifEnabled ? colors.text.primary : colors.text.muted}
            />
          </View>

          {notifEnabled && (
            <>
              {channels.map((ch) => (
                <View key={ch.id} style={styles.settingRow}>
                  <View>
                    <Text style={styles.settingLabel}>{ch.name}</Text>
                    <Text style={styles.settingHint}>{ch.description}</Text>
                  </View>
                  <Switch
                    value={ch.enabled}
                    onValueChange={(v) => handleToggleChannel(ch.id, v)}
                    trackColor={{ false: colors.border.default, true: colors.cyan }}
                    thumbColor={ch.enabled ? colors.text.primary : colors.text.muted}
                  />
                </View>
              ))}

              {pushToken && (
                <View style={styles.tokenRow}>
                  <Text style={styles.tokenLabel}>Push Token</Text>
                  <Text style={styles.tokenValue} numberOfLines={1}>
                    {pushToken.slice(0, 30)}...
                  </Text>
                </View>
              )}
            </>
          )}
        </Card>

        <Card title="Watched Account Alerts">
          <View style={styles.settingRow}>
            <View style={styles.settingText}>
              <Text style={styles.settingLabel}>Push alerts</Text>
              <Text style={styles.settingHint}>
                Off by default. Sends threshold and anomaly alerts for watched accounts.
              </Text>
            </View>
            <Switch
              value={!!watchPush?.enabled}
              disabled={watchPushBusy || !watchPush}
              onValueChange={toggleWatchPush}
              accessibilityLabel="Push alerts for watched accounts"
              trackColor={{ false: colors.border.default, true: colors.cyan }}
              thumbColor={watchPush?.enabled ? colors.text.primary : colors.text.muted}
            />
          </View>

          {watchPush?.enabled && (
            <>
              <View style={styles.settingRow}>
                <Text style={styles.settingLabel}>Threshold alerts</Text>
                <Switch
                  value={watchPush.categories.threshold}
                  onValueChange={(v) => updateWatchPush({ categories: { ...watchPush.categories, threshold: v } })}
                  accessibilityLabel="Threshold alerts"
                  trackColor={{ false: colors.border.default, true: colors.cyan }}
                />
              </View>
              <View style={styles.settingRow}>
                <Text style={styles.settingLabel}>Anomaly alerts</Text>
                <Switch
                  value={watchPush.categories.anomaly}
                  onValueChange={(v) => updateWatchPush({ categories: { ...watchPush.categories, anomaly: v } })}
                  accessibilityLabel="Anomaly alerts"
                  trackColor={{ false: colors.border.default, true: colors.cyan }}
                />
              </View>
              <TouchableOpacity
                style={styles.settingRow}
                onPress={cycleWatchPushLevel}
                accessibilityRole="button"
                accessibilityLabel={`Minimum severity: ${watchPush.minLevel}. Tap to change.`}
              >
                <Text style={styles.settingLabel}>Minimum severity</Text>
                <Text style={styles.settingValue}>{watchPush.minLevel}</Text>
              </TouchableOpacity>
            </>
          )}
        </Card>

        <Card title="Account">
          {connectedAddress ? (
            <>
              <View style={styles.settingRow}>
                <Text style={styles.settingLabel}>Connected</Text>
                <Text style={styles.settingValue}>
                  {connectedAddress.slice(0, 8)}...
                </Text>
              </View>
              <Button
                title="Disconnect"
                onPress={handleDisconnect}
                variant="danger"
                size="sm"
                style={{ marginTop: spacing.sm }}
              />
            </>
          ) : (
            <Text style={styles.hint}>No account connected</Text>
          )}
        </Card>

        <Card title="About">
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Version</Text>
            <Text style={styles.settingValue}>0.1.0</Text>
          </View>
          <Text style={styles.hint}>Stellar Developer Dashboard Mobile</Text>
        </Card>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.background,
  },
  scrollContent: {
    padding: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  screenTitle: {
    fontSize: typography.fontSize.xl,
    fontWeight: typography.fontWeight.bold,
    color: colors.text.primary,
    marginBottom: spacing.md,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  settingLabel: {
    fontSize: typography.fontSize.sm,
    color: colors.text.primary,
    fontWeight: typography.fontWeight.medium,
  },
  settingValue: {
    fontSize: typography.fontSize.sm,
    color: colors.cyan,
    fontWeight: typography.fontWeight.medium,
  },
  settingHint: {
    fontSize: typography.fontSize.xs,
    color: colors.text.muted,
    marginTop: 1,
  },
  settingText: {
    flex: 1,
    paddingRight: spacing.sm,
  },
  hint: {
    fontSize: typography.fontSize.xs,
    color: colors.text.muted,
    marginTop: spacing.xs,
  },
  tokenRow: {
    paddingVertical: spacing.sm,
  },
  tokenLabel: {
    fontSize: typography.fontSize.xs,
    color: colors.text.muted,
  },
  tokenValue: {
    fontSize: typography.fontSize.xs,
    color: colors.text.secondary,
    fontFamily: undefined,
    marginTop: 2,
  },
})
