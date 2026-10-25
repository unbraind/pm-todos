# Example: edit a todo.txt snapshot safely

Sessions work in a plain tracker directory. Git is optional.

```sh
pm todos session export --file todo.txt --session todo.session.json --json
# Edit text, priorities, +projects, @contexts, due dates or key:value tokens.
pm todos session preview --file todo.txt --session todo.session.json --json
pm todos session apply --file todo.txt --session todo.session.json --json
```

Each line ends with `pm-session:<id>`. Keep that token with its line when
reordering. Keep the versioned JSON sidecar unchanged. Export refuses to
overwrite either file; use fresh filenames for a fresh baseline. Failed exports
remove outputs created by that attempt so the same filenames can be retried.
Export rejects titles that todo.txt would reinterpret as metadata (for example,
`Meeting at 10:30`, `Work +sdk` or `Call @home`) and names the affected item.
Use JSONL export for those items and for multiline titles or invalid dates.

Suppose the snapshot has `(C) Fix parser +sdk pm-session:demo-one`. Change
`Fix parser` to `Fix unicode parser`. A concurrent priority change in the
tracker survives apply. A concurrent title change produces `field_conflict`
with the affected ID, field and remedy. Preview does not write item/history
state. Apply rechecks against the baseline inside each core item lock.
Before writing, apply reads history afresh and uses the pm SDK's
`verifyHistoryEntries` to check both the chain and the locked item. Missing,
empty, hash-corrupt or drifted history returns `write_failed` without changing that
item or appending history. A primed event-index cache cannot authorize a write.
This is stricter than the previous session implementation, which could append
an edit to a damaged chain. Preview remains a non-writing three-way comparison;
its success does not certify history integrity for a later apply.

Removing a line means “leave this item alone”; it never deletes or closes an
item. New lines without a known identity refuse with a remedy to use `pm create`.
Checking or unchecking a task returns `lifecycle_required`: use `pm close` or
`pm reopen` with a reason, then export a new session. This preserves the core
lifecycle contract and prevents a text edit from bypassing completion evidence.

SDK consumers import `createTodoEditingSession`, `reconcileTodoEditingSession`,
`exportTodoEditingSession`, `applyTodoEditingSession` and their public types
from `pm-todos`. Pure helpers accept arrays of `PmItem`; tracker helpers use
certified complete reads and the public core mutation path. Example:

```ts
import { exportTodoEditingSession, applyTodoEditingSession } from "pm-todos";
const { session, text } = await exportTodoEditingSession(trackerRoot);
const receipt = await applyTodoEditingSession(trackerRoot, session, editedText, {
  author: "editing-agent", dryRun: true,
});
```

Receipts report `changed`, `applied`, `unchanged`, `omitted`, `refusalCount` and
at most 20 refusals (`hasMore` signals truncation). Values and task text are not
repeated in refusals. CLI output uses the host's compact TOON default or `--json`;
refusals exit nonzero. Use a new session after resolving conflicts. Sidecars
contain task text; store them with the same access policy as the tracker.
Sidecar digests detect accidental corruption; they do not authenticate the
baseline or protect against tampering, since anyone can recompute them. Accept
sidecars only from a trusted export and retain their access controls while editing.

All known input conflicts prevent writes. Apply is atomic per item through core
locking and append-only history. It is not a multi-item transaction: a late race,
ownership refusal or storage error may leave earlier rows applied, reported by
`applied`. Preview again before retrying. Core transactions own batch atomicity;
this package does not implement a second transaction coordinator. Unchanged
imports, including replay after apply, append no item history. Ordinary tracker
metadata absent from todo.txt, including descriptions and status variants, is
preserved. Whitespace and lossy formatting alone do not reset unrelated fields.

## SDK transaction adoption boundary

The 2026-10-25 audit identified the per-item session mutation callback as a
candidate for `previewItemMutations` / `commitItemMutations`. The supported
2026.10.20 SDK floor and the inspected 2026.10.25 SDK expose the same relevant
limits. Sessions retain the public SDK's `mutateItem` instead of replacing it
with a transaction that loses source conflict checks or standalone operation.

| Finding | Capability considered | Missing contract / evidence |
| --- | --- | --- |
| `sessions.ts` per-item preconditions | Update `match` in `previewItemMutations` / `commitItemMutations` | `BulkItemUpdateMutation.match` accepts one exact `{key, value}`. A title edit must also protect `todos_todotxt`, and source serialization must incorporate independent priority/tag/deadline changes under the item lock. Need multi-field expected-state guards plus locked replanning, or a transaction update callback. Matching only title admits a stale source; matching only source admits a stale title. A blanket `updated_at` guard would reject independent changes currently merged by sessions. |
| Same update, extension metadata | Transaction update options | Need a supported per-update `extensionFieldNames` contract (as on `mutateItem`) or scoped field registration for standalone package SDK calls. `field: ["todos_todotxt=..."]` refuses when the extension is not installed. Undeclared direct metadata options are not a replacement for the registered field path. Requiring installation would break plain SDK callers. |
| Certified reader and watcher locks | Already adopted | The audit explicitly excludes these completed migrations; no additional replacement is needed. |

Run `node --test test/sdk-session-adoption.test.ts` for real non-git tracker
counterexamples and corruption-after-cache verification. Existing held-lock
tests in `test/sessions.test.ts` cover title races and preservation of independent
priority, tag and deadline changes. No SDK dependency or supported host floor
changes are required for the integrity check.

`npm run build && node scripts/compare-sdk-sessions.ts <public-repo> ...`
builds `origin/main` separately and compares built session creation, reconciliation,
planning, export and dry-run apply against the current build. Only committed
public tracker data is extracted. Copies live outside git, copied tracker files
are read-only, child processes have no git executable, and a full-file digest
asserts the copied tracker was unchanged. Output contains only repository heads
and counts. The intentional corrupt-history apply refusal is tested separately
on disposable synthetic trackers; the differential command performs no apply writes.
