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
