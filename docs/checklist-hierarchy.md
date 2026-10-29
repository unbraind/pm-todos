# Review checklist relationships

Start with an explicit selection such as `["demo-root", "demo-child", "demo-other"]`
in `ids.json`. Include every selected row's parent/blocker; export reports and skips an
orphaned child instead of flattening it into an accidental detach. If a parent
cannot export, its dependent rows are skipped too; independent rows still export.
Export uses fresh output filenames and mode 0600. Partial files are retained if
another writer could have edited them; inspect them and choose fresh filenames.

```sh
pm todos hierarchy export --selection ids.json --file checklist.md --session hierarchy.json
```

The checklist initially contains:

```md
- [ ] Root <!-- pm-session:demo-root -->
  - [ ] Child <!-- pm-session:demo-child -->
- [ ] Other <!-- pm-session:demo-other -->
```

Move the child's marked row under Other with two spaces of indentation. Preview
proposes exactly one `parent` change, from `demo-root` to `demo-other`, then apply
persists that change through the native SDK. Title text and checkboxes are display
only: renaming Root to Other cannot select a different parent. A root has no
parent; unindenting a child explicitly proposes clearing its parent.

```sh
pm todos hierarchy preview --file checklist.md --session hierarchy.json --json
pm todos hierarchy apply --file checklist.md --session hierarchy.json --json
```

To interpret indentation as prerequisite edges instead, choose
`--relation blocked_by` **at export**. Each indent parent is then the child's
native `blocked_by`, maintained with its native dependency edge by core. Moving
that edge removes its previous target explicitly in the same native update. Rows
with multiple/divergent blockers are reported individually and skipped at export;
one indent cannot represent several prerequisites. Other dependency kinds survive. This does not infer generic dependencies or scheduling facts
from ordinary Markdown. Custom statuses are classified through the configured
SDK status registry, including custom terminal/canceled roles; no status is changed.

SDK callers use the same functions exported from `pm-todos`:

```ts
import { exportTodoHierarchy, applyTodoHierarchy } from "pm-todos";
const { session, text } = await exportTodoHierarchy(pmRoot, selectedCanonicalIds);
const preview = await applyTodoHierarchy(pmRoot, session, editedText, {
  author: "repair-agent", dryRun: true,
});
if (preview.ok) {
  const applied = await applyTodoHierarchy(pmRoot, session, editedText, {
    author: "repair-agent",
  });
}
```

The optional SDK injection accepts public peer primitives. Otherwise the lazy
supported module loader resolves `@unbrained/pm-cli/sdk`; it never inspects argv,
`which`, global binary symlinks or private host internals. The same field-proposal function produces preview graphs and mutations inside
the SDK's native item lock. Core graph validators reject hierarchy defects and
ordering cycles; core `mutateItem` owns locking, ownership checks and append-only
history. Only the chosen relationship fields are set or removed explicitly.
No native create/update defaulting is involved, so ambient focus cannot assign a
parent and unrelated legacy fields stay intact.

Selections contain 1..1000 unique canonical IDs; input arrays are dense plain
JSON arrays. The CLI selection file is at most 256 KiB; the sidecar and Markdown
files are each at most 1 MiB. Markdown is at most 1 MiB and 1000 rows, with at most 100 levels,
exactly two spaces per indent and no tab indentation. CRLF and trailing/editor
text whitespace are accepted. Export skips unrepresentable display rows alone
and reports their IDs. Existing native titles containing punctuation, metadata
syntax or old spellings remain readable; no new validation rewrites stored data.
The sidecar is checked by the same strict schema used by its producer. Its digest
is an integrity check, not authentication: retain trusted sidecars with tracker
access controls. It contains IDs/revisions and relations, not native title text.

Receipts use TOON by default or `--json`. Counts are finite safe integers in
0..1000. `changes` and `affected` contain at most 40 entries each; separate
`omittedChanges` and `omittedAffected` counts disclose truncation. No task bodies,
paths, native values unrelated to relations, or similarity scores appear.
Refusals exit nonzero and carry a stable code and remedy. Resolve
`orphan_row`/`ambiguous_indent` by retaining markers and the preceding ancestor;
resolve `cycle` through explicit native topology review; restore missing items or
export fresh after `missing_item`/`stale_revision`. Damaged history is preserved
and reported as `invalid_history`.

Every apply invocation replans from SDK reads. Complete native histories verify
both item integrity and a revision of growing length plus hash head, detecting
ABA changes. Replay is unchanged only after reading current state and proving
that one exact revision-bound native update produced it, with every unrelated
field preserved. Older inputs cannot undo later edits; foreign history records
refuse with a remedy. There is no package-owned mutable checkpoint, claim, lease
or frozen journal plan to replay. A skipped export row cannot authorize a child
that depends on it.

Preview and apply validate the final graph and schedule only native item changes
whose every persisted intermediate graph passes the same SDK topology validators.
The order can differ from checklist order: for example, a blocker detachment must
precede an edge that would otherwise form a temporary cycle. No temporary detach
writes or compensating edits are invented. If no fully validated sequence is found, `cycle`
refuses before writes with a native-review remedy. A later ownership refusal or
interruption therefore leaves only previously validated graph prefixes.

All known conflicts and native topology failures prevent writes. Before **each**
native write, apply re-reads every selected revision and revalidates topology
inside that target's native item lock, including the exact next intermediate
graph rather than only the planned final graph. Ordinary SDK writers share this item lock,
so a concurrent edit to that target cannot slip past the revision check. Other
items can still change after their last read and before this target is persisted.
There is no workspace isolation from ordinary writers (pm-cli #1620/#1576). No multi-item atomicity is claimed. A late race or native
ownership refusal can leave earlier repairs applied; `applied` reports that
progress. Preserve the receipt and preview again. Retry rechecks all targets,
including those already applied and unchanged. A stale prerequisite stops all
remaining steps; no dependent row is applied blindly. Native item/history
persistence and ownership enforcement remain core responsibilities.

`node --test --test-concurrency=2 test/hierarchy.test.ts test/hierarchy-roundtrip-model.test.ts` exercises real non-git
trackers, exact peer-write boundaries, replay/ABA, extreme inputs and 500 seeded
operation sequences against an independent state model, reading every assertion
back through the SDK. `node scripts/validate-hierarchy.ts <public-package-repo>`
extracts committed public tracker data into a read-only non-git scratch copy,
previews it and reports counts and byte preservation without changing the source.

The inspected SDK 2026.10.25 `previewItemMutations` cannot supply this preview
contract: it returns `EACCES` on read-only copies and rejects symlinks introduced
by ordinary installed extensions (`transaction_preview_non_regular_file`). Its
public signature has no staging-permission/exclusion control. Those measured
limits are tracked by `pm-todos-hierarchy-readonly-preview`; they explain why this
feature uses public graph validators plus the native item-mutation API. Changed
previews work on immutable input without executing extension mutation hooks.
Apply still enforces native ownership/guards; a preview cannot promise that a
later hook, ownership change or storage operation will succeed.
