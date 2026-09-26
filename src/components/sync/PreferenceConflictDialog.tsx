/**
 * PreferenceConflictDialog — resolve conflicting preference writes (#891).
 *
 * Shows each conflicting preference side by side, pre-selects the configured
 * strategy's choice, and applies the merge only when every conflict has a
 * valid choice. Resolution logic lives in `lib/preferenceSyncConflicts`.
 */

import React, { useMemo, useState, type CSSProperties } from 'react'
import {
  PreferenceSyncError,
  applyConflictResolution,
  defaultChoices,
  formatPreferenceValue,
  newestSide,
  type ConflictReport,
  type ConflictStrategy,
  type ResolutionChoices,
  type SyncInput,
  type SyncSide,
} from '../../lib/preferenceSyncConflicts'
import type { UserPreferences } from '../../lib/userPreferences'

interface Props {
  input: SyncInput
  report: ConflictReport
  strategy: ConflictStrategy
  onResolve: (preferences: UserPreferences) => void | Promise<void>
  onCancel: () => void
  now?: () => Date
}

const SIDE_LABEL: Record<SyncSide, string> = { local: 'This device', remote: 'Other device' }

export default function PreferenceConflictDialog({
  input,
  report,
  strategy,
  onResolve,
  onCancel,
  now = () => new Date(),
}: Props) {
  const initial = useMemo(
    () => defaultChoices(report, strategy, input.local, input.remote),
    [report, strategy, input.local, input.remote],
  )
  const [choices, setChoices] = useState<ResolutionChoices>(initial)
  const [error, setError] = useState<PreferenceSyncError | null>(null)
  const [busy, setBusy] = useState(false)

  const choose = (path: string, side: SyncSide) => setChoices((c) => ({ ...c, [path]: side }))

  const chooseAll = (side: SyncSide | 'newest') => {
    const next: ResolutionChoices = {}
    const target = side === 'newest' ? newestSide(input.local, input.remote) : side
    for (const conflict of report.conflicts) {
      const other: SyncSide = target === 'local' ? 'remote' : 'local'
      next[conflict.path] = conflict.invalidSides.includes(target) ? other : target
    }
    setChoices(next)
  }

  const apply = async () => {
    setError(null)
    setBusy(true)
    try {
      const { preferences } = applyConflictResolution(input, report, choices, now())
      await onResolve(preferences)
    } catch (e) {
      setError(
        e instanceof PreferenceSyncError
          ? e
          : new PreferenceSyncError('INVALID_RESULT', e instanceof Error ? e.message : 'Could not save preferences.'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="pref-conflict-title" style={styles.dialog}>
      <h3 id="pref-conflict-title" style={styles.title}>
        Resolve {report.conflicts.length} preference conflict{report.conflicts.length === 1 ? '' : 's'}
      </h3>
      <p style={styles.hint}>
        {report.hasBase
          ? 'These settings were changed differently on both devices since the last sync.'
          : 'This is the first sync between these devices, so every difference needs a choice.'}
        {report.autoMerged.length > 0 &&
          ` ${report.autoMerged.length} other change${report.autoMerged.length === 1 ? '' : 's'} will be merged automatically.`}
      </p>

      <div style={styles.bulk} role="group" aria-label="Resolve all conflicts">
        <button type="button" style={styles.button} onClick={() => chooseAll('local')}>
          Keep all from this device
        </button>
        <button type="button" style={styles.button} onClick={() => chooseAll('remote')}>
          Use all from other device
        </button>
        <button type="button" style={styles.button} onClick={() => chooseAll('newest')}>
          Newest wins
        </button>
      </div>

      <div style={styles.list}>
        {report.conflicts.map((conflict) => (
          <fieldset key={conflict.path} style={styles.row} data-testid={`conflict-${conflict.path}`}>
            <legend style={styles.legend}>
              {conflict.label} <code style={styles.path}>{conflict.path}</code>
            </legend>
            {(['local', 'remote'] as SyncSide[]).map((side) => {
              const invalid = conflict.invalidSides.includes(side)
              const id = `${conflict.path}-${side}`
              return (
                <label key={side} htmlFor={id} style={{ ...styles.option, opacity: invalid ? 0.55 : 1 }}>
                  <input
                    id={id}
                    type="radio"
                    name={conflict.path}
                    value={side}
                    checked={choices[conflict.path] === side}
                    disabled={invalid}
                    onChange={() => choose(conflict.path, side)}
                  />
                  <span>
                    <strong>{SIDE_LABEL[side]}:</strong> {formatPreferenceValue(conflict[side])}
                    {invalid && <em> (invalid value, cannot be used)</em>}
                  </span>
                </label>
              )
            })}
          </fieldset>
        ))}
      </div>

      {error && (
        <div role="alert" style={styles.error}>
          {error.message}
          {error.details.length > 0 && ` (${error.details.join(', ')})`}
        </div>
      )}

      <div style={styles.actions}>
        <button type="button" style={styles.button} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" style={{ ...styles.button, ...styles.primary }} onClick={apply} disabled={busy}>
          {busy ? 'Applying…' : 'Apply resolution'}
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  dialog: {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    padding: '14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  title: { margin: 0, fontSize: '14px', fontWeight: 700 },
  hint: { margin: 0, fontSize: '12px', color: 'var(--text-muted)' },
  bulk: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  list: { display: 'flex', flexDirection: 'column', gap: '8px' },
  row: {
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    padding: '8px 10px',
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  legend: { fontSize: '12px', fontWeight: 600, padding: '0 4px' },
  path: { fontSize: '10px', color: 'var(--text-muted)' },
  option: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' },
  error: {
    fontSize: '12px',
    color: 'var(--error)',
    padding: '6px 8px',
    border: '1px solid var(--error)',
    borderRadius: 'var(--radius-sm)',
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
  button: {
    padding: '6px 10px',
    fontSize: '12px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  primary: { background: 'var(--cyan)', color: 'var(--bg-base, #000)', borderColor: 'var(--cyan)' },
}
