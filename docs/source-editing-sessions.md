# Move an identified row between files

Create `selection.json` with explicit logical filenames and canonical item IDs:

```json
{"sources":[{"file":"today.txt","ids":["demo-one"]},{"file":"later.txt","ids":["demo-two"]}]}
```

```sh
mkdir edits
pm todos sources export --selection selection.json --manifest baseline.json --directory edits --json
# Move the entire demo-one line from edits/today.txt to edits/later.txt.
pm todos sources preview --manifest baseline.json --directory edits --json
pm todos sources apply --manifest baseline.json --directory edits --json
```

Each line retains its trailing `pm-session:<id>` identity. Keep the manifest
unchanged. Every manifest identity must occur exactly once across the selected
files. A duplicate or missing identity refuses the selection. New unidentified
lines require `pm create`, followed by a fresh export. Export creates fresh files
exclusively; it never overwrites editing work. Parent directories must exist.
Failed exports retain any outputs already created, since another editor may
have touched them. Inspect those files and export into a fresh editing directory.
An unsupported or foreign-owned row is skipped individually during export,
with a bounded refusal naming its ID. If every selected row is unusable, export
refuses without producing a manifest.

The manifest binds each row to its original file, previous `todos_source_file`
ownership and native immutable history revision. Apply records the current file
in `todos_source_file`, using one update for a moved row. The initial apply also
records previously unassigned ownership. For another editing session, export
each row under its current owner; then move its line. The manifest never discovers
other files. File names are relative to the explicit editing directory; operator
paths for the directory, selection and manifest may be absolute.

An unchanged second file is still part of the selection: any intervening native
history event on one of its rows causes `stale_revision` before writes. This
includes ABA edits that restore the original content. Resolve the peer edit,
export all selected rows again and review the intended move. Status and lifecycle
changes require the core lifecycle commands. Configured status registry roles
govern checkbox rendering; custom status names are preserved. Native bodies,
relationships, scope fields and other unrepresented metadata survive unchanged.

## SDK

```ts
import { exportTodoSourceSelection, applyTodoSourceSelection } from "pm-todos";

const exported = await exportTodoSourceSelection(trackerRoot, {
  sources: [{ file: "today.txt", ids: ["demo-one"] }, { file: "later.txt", ids: [] }],
});
exported.files[1].text = exported.files[0].text;
exported.files[0].text = "";
const preview = await applyTodoSourceSelection(trackerRoot, exported.manifest,
  exported.files, { author: "editing-agent", dryRun: true });
const result = await applyTodoSourceSelection(trackerRoot, exported.manifest,
  exported.files, { author: "editing-agent" });
```

`TodoSourceSelection`, `TodoSourceManifest`, `TodoSourceFile`, `TodoSourceExport`,
`TodoSourceResult`, `TodoSourceCode`, `TodoSourceError`, `TodoSourceApplyOptions`
and `TodoSourceSdk` are public types. `parseTodoSourceManifest` validates a
manifest before a transport opens any of its named files. SDK calls can inject
the public native SDK through `sdk`; otherwise the declared public peer export
is loaded lazily with Node's module loader. CLI transactions use the host's
injected coordinator. No executable, argv or global symlink discovery is used.

All inputs share one strict schema: 1..32 unique files, 1..1000 unique rows,
dense arrays, 160-character canonical IDs, 240-character relative source names,
and at most 4 MiB of editable text in total. A source line is bounded to 65536
characters. CLI JSON selection and manifest limits are 1 MiB and 16 MiB.
Malformed input refuses before tracker mutation. Digests detect accidental
corruption; trusted manifests and their task text need the tracker's access
policy. They are not authentication signatures.

Receipts use compact TOON by default or JSON with `--json`. They contain bounded
counts (`files`, `selected`, `changed`, `applied`, `moved`, `unchanged`), the native
transaction ID and typed refusals with remedies, without task values. Export
reports `skipped` and at most 20 refusals. Counts are checked as finite safe
integers. `moved` counts proposed ownership assignments, including initial ones.
Preview runs the same normalization, field planner and ownership checks as apply.
Whitespace and CRLF use the existing fidelity producer, including for journal
identity. A successful replay reads the current native targets and reports zero
changes; an old input never bypasses a new history revision.

## Transactions and concurrent writers

A fenced SDK selection lease serializes competing selections on the same plain
tracker. Every item write rechecks native history under its SDK item lock.
The SDK workspace transaction owns journaling and reverse compensation. Its
idempotency identity includes the manifest's target revisions. Recovery validates
every target, including previously completed rows; dependent rows never proceed
after a refusal. Retained package history markers recognize a peer's completed
application without counting another write.

Recovery recognizes baseline, applied and compensated states through one shared
native-history classifier. It anchors the entire operation suffix to the exported
revision, verifies alternating forward/compensation records, and uses SDK history
replay and canonicalization to prove that compensation restored the original
owned fields while preserving other metadata, relationships and bodies. Forward
intent comes from the exported native baseline and the same planner and patch
applicator as actual writes. Every apply event must equal that complete intended
projection, including owned fields the edit did not change. This also refuses a
poisoned intermediate event hidden by later compensation. Saved compensation
values must match the verified baseline, and success requires a final SDK read
showing no pending selection changes. A copied marker alone never authorizes a
peer revision. This check runs at preview, item
inspection, compensation preparation, locked mutation and compensation itself.
The native coordinator can therefore finish an interrupted rollback before it
starts a fresh forward attempt, including after repeated rollback interruptions.

`changed`, `moved` and `unchanged` describe the logical differences from current
values at the start of apply, matching preview. `applied` counts forward writes
retained from this call. Recovery may first undo a prior forward write and then
reapply it, so `applied` can exceed `changed`; those append-only audit events are
recovery work, not additional logical row moves.

This uses core's compensating transaction contract, not snapshot isolation for
arbitrary native writers. A late native race triggers compensation; audit and
compensation history remain append-only. If a peer touches an already applied
row, compensation refuses with `superseded` and preserves the peer's change.
The receipt's `applied` count then reports this attempt's unrolled-back writes;
preserve and reconcile the native journal before retrying. A process interruption
likewise returns a refusal and may retain writes; replay the same selection to
recover while its native revisions still validate. Preview does not certify
permissions, workflow hooks or future commit-time state.

Everything here works without git. The public-data validation script alone
requires git to extract committed public input; the resulting tracker is read-only
and outside a repository. Run `node scripts/validate-source-sessions.ts <public-repo>`
to report only heads, counts and byte sizes. Tests cover real non-git trackers,
500 seeded operation sequences, custom status registries, ambient focus, older
replays, extreme inputs and every native transaction transition.

The package now requires pm CLI 2026.10.23 for its public fenced lease API.
The development SDK pin is unchanged. New `__proto__` todo.txt metadata tokens
refuse before mutation because the supported native history codec cannot safely
round-trip that key. Other ordinary keys, including `constructor` and `toString`,
are exercised through native read-back. Existing tracker values are never repaired
or rewritten to bypass an integrity refusal.

## Public-data measurement

At public `unbraind/pm-todos` main
`847bc287478df47ebd3bc6f525d2e6d8b29b40ef`, validation inspected 102 items:
101 selected rows, one individually skipped unsupported row, two files,
11413 text bytes and a 106696-byte manifest. The move preview succeeded;
duplicate ownership produced one refusal. Zero writes were applied, and a
fingerprint of every copied file stayed identical. The copy was read-only,
outside git and evaluated with no git executable on PATH. This is preview and
export evidence on real public data; mutation and recovery evidence comes
from the real synthetic trackers in the tests.
