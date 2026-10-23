# Review stable todo changes from the SDK

Export a session once, keep its sidecar unchanged, and edit the accompanying
newline-terminated todo.txt file. The source file is authorized by its explicit
path; the watcher does not discover other files.

```ts
import { TodoSourceWatcher, type TodoWatcherReceipt } from "pm-todos";

const watcher = new TodoSourceWatcher({
  pmRoot: "tracker",
  file: "review.txt",
  sessionFile: "baseline.json",
  spool: "proposals",
  stableMs: 500,
  maxChanges: 50,
  maxPending: 10,
});
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
await watcher.run(controller.signal, (receipt: TodoWatcherReceipt) => {
  console.log(JSON.stringify(receipt));
});
```

`poll()` samples once for hosts with their own event loop. Repeated calls must
span the stability window. Only a `queued` receipt reports newly persisted review
evidence; `duplicate` identifies a revision already preserved. Refusals include a
stable `code` and an actionable `remedy`. `plan_refused` adds at most 20 existing
session refusals with an exact count and omission indicator.

Read `proposals/proposals.json` for the full bounded `TodoChangeProposal`: `text`,
`patches`, session result, and source/session/tracker revision hashes. Review a
saved proposal snapshot against the original baseline with `todos session preview`
and explicitly apply only after review. The watcher never calls apply. Preserve
the queue when shutting down or encountering a refusal. Archive reviewed queues
and use a fresh spool rather than deleting rows in a live queue.

For repeatable public-data acceptance, supply a read-only public tracker copy in a
plain directory to `node scripts/validate-source-watcher.ts tracker-copy`. The
script checks partial writes, truncation, replacement/restart deduplication,
shutdown retention and unchanged tracker bytes. Its JSON receipt contains only
measured counts and byte sizes, with no tracker text or local paths.
