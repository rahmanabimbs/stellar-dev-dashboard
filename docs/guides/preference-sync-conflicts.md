# Resolving preference conflicts across devices

When you use the dashboard on more than one device, you can change the same
setting differently on each. The multi-device sync flow detects these
conflicting writes and lets you choose which value to keep. The result is
deterministic: both devices reach the same preferences.

## Using it

1. On device A, open **Settings → Multi-device sync** and click
   **Create sync snapshot**. Copy the text that appears.
2. On device B, open the same section, paste the snapshot into
   **Snapshot from another device**, and click **Compare and merge**.
3. What happens next depends on what changed:
   - **No conflicts.** Changes made on only one device are merged
     automatically and saved.
   - **Conflicts.** A dialog lists each conflicting setting with both values.
     Choose per setting, or use **Keep all from this device**, **Use all from
     other device**, or **Newest wins**. Click **Apply resolution** to save, or
     **Cancel** to change nothing.
4. To bring device A up to date, repeat in the other direction: snapshot on B,
   paste on A.

## How conflicts are detected

Each merge is a three-way comparison between this device, the other device, and
the **base**: the preferences both devices had at their last successful sync on
this device.

| This device vs base | Other device vs base         | Result                                      |
| ------------------- | ---------------------------- | ------------------------------------------- |
| unchanged           | changed                      | Take the other device's value automatically |
| changed             | unchanged                    | Keep this device's value automatically      |
| changed             | changed to the same value    | No conflict                                 |
| changed             | changed to a different value | **Conflict**: you choose                    |

On the first sync between two devices there is no base yet, so every difference
is shown as a conflict.

Synced fields are every setting in `PREFERENCE_SCHEMA` (including the
`advanced.*` options), plus the address book, dashboard layout, custom presets,
custom network profiles, transaction confirmation settings, and notification
preferences. List and object fields such as the address book are compared as a
whole; they are not merged item by item.

## Deterministic defaults

The dialog pre-selects a choice for every conflict using the
`sync.conflictStrategy` preference:

| Strategy           | Default choice                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `newest` (default) | The device whose preferences were modified most recently. If both times are identical, the device with the lexicographically greater device id wins, so both devices pick the same side. |
| `local`            | This device                                                                                                                                                                              |
| `remote`           | The other device                                                                                                                                                                         |

"Modified" means the last time preferences were saved on that device
(`sync.lastModifiedAt`), not when the snapshot was created.

A value that fails preference validation (for example an unknown theme from a
newer app build) is marked as invalid in the dialog and cannot be selected.
Defaults never pre-select an invalid value.

## Errors

| Message                                                                  | Cause                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| The snapshot is not valid JSON / This is not a preferences sync snapshot | The pasted text is incomplete or came from somewhere else. Copy the whole snapshot again. |
| This snapshot came from this device                                      | Paste the snapshot created on the _other_ device.                                         |
| … use schema vN, newer than this app                                     | The other device runs a newer version. Update this device first. Nothing is merged.       |
| Choose a value for every conflict                                        | A conflict was left without a choice.                                                     |
| The merged preferences are invalid                                       | The chosen values fail validation. Pick the other value for the listed settings.          |

## For developers

The logic is in
[`src/lib/preferenceSyncConflicts.ts`](../../src/lib/preferenceSyncConflicts.ts),
and the UI in
[`src/components/sync/PreferenceConflictDialog.tsx`](../../src/components/sync/PreferenceConflictDialog.tsx)
and
[`PreferenceSyncPanel.tsx`](../../src/components/sync/PreferenceSyncPanel.tsx).

```ts
import {
  detectPreferenceConflicts,
  defaultChoices,
  applyConflictResolution,
  toSnapshot,
} from '../lib/preferenceSyncConflicts';

const input = { base, local: toSnapshot(localPrefs), remote: parseSyncSnapshot(text) };
const report = detectPreferenceConflicts(input);
const choices = defaultChoices(report, localPrefs.sync.conflictStrategy, input.local, input.remote);
const { preferences } = applyConflictResolution(input, report, choices);
```

All failures throw `PreferenceSyncError` with a `code` (`INVALID_SNAPSHOT`,
`INCOMPATIBLE_SCHEMA`, `UNRESOLVED_CONFLICT`, `UNKNOWN_CONFLICT`, `INVALID_CHOICE`,
`INVALID_RESULT`) and a `details` array naming the affected fields or paths.

A future server-backed sync transport can reuse the same functions: send
`toSnapshot()` output, store the merged result as the new base, and show
`PreferenceConflictDialog` when `report.conflicts` is non-empty.

Tests:

```bash
pnpm exec vitest run --config vitest.config.js src/lib/__tests__/preferenceSyncConflicts.test.ts src/components/sync
```

## Compatibility and migration

- Existing installs have the shared default device id `local`. A random id
  (`device-…`) is assigned the first time you create a snapshot or compare.
- `sync.lastModifiedAt` is new. It is written on every preference save.
  Preferences saved before this release fall back to `sync.lastSyncedAt`, then to
  the Unix epoch, so an older device loses "newest wins" ties until it saves once.
- The base is stored in IndexedDB under `preference-sync-base-v1`. Clearing site
  data removes it, and the next sync is treated as a first sync.
- Snapshots from a newer preference schema are rejected rather than downgraded.
  Older snapshots are migrated forward before comparison.

## Security notes

- Snapshots contain your preferences, including saved addresses, custom network
  profiles, and the transaction confirmation email if set. They never contain
  secret keys. Treat a snapshot like an exported settings file and don't share it
  publicly.
- Snapshots are plain JSON that you copy yourself. Nothing is uploaded to a
  server.
