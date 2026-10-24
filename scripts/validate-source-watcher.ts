/** Measure watcher acceptance against a supplied read-only public tracker copy outside git. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { createTodoEditingSession, TodoSourceWatcher, type PmItem, type TodoWatcherReceipt } from "../index.ts";

/** Hash every supplied tracker file; reject linked entries rather than following them. */
function fingerprint(root: string): { digest: string; files: number } {
  const hash = createHash("sha256");
  let files = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      assert.ok(!entry.isSymbolicLink(), "Public copy must not contain links");
      const path = join(directory, entry.name);
      hash.update(entry.name);
      if (entry.isDirectory()) visit(path); else { files++; hash.update(readFileSync(path)); }
    }
  };
  visit(root);
  return { digest: hash.digest("hex"), files };
}

const source = process.argv[2];
if (!source) throw new Error("Pass a read-only public tracker copy outside git.");
const before = fingerprint(source);
const root = mkdtempSync(join(tmpdir(), "todos-public-watch-"));
try {
  const items = (await listAllComplete({}, { pmRoot: source, noExtensions: true })).items as PmItem[];
  const eligible = items.filter(item => { try { createTodoEditingSession([item]); return true; } catch { return false; } });
  assert.ok(eligible.length > 0, "Public copy has no session-compatible items");
  const baseline = createTodoEditingSession(eligible);
  const file = join(root, "todo.txt"), sessionFile = join(root, "baseline.json"), spool = join(root, "queue");
  writeFileSync(sessionFile, JSON.stringify(baseline.session));
  const edited = baseline.text.split("\n").map(line => line.endsWith(`pm-session:${eligible[0].id}`) ? line.replace(eligible[0].title.trim().split(/\s+/).join(" "), "Watcher validation title") : line).join("\n");
  assert.notEqual(edited, baseline.text, "Public fixture needs a representable editable title");
  const config = { pmRoot: source, file, sessionFile, spool, stableMs: 1, pollMs: 1 };
  const watcher = new TodoSourceWatcher(config);
  const settle = (): Promise<TodoWatcherReceipt> => watcher.runOnce();
  writeFileSync(file, edited.slice(0, -3));
  const partial = await settle();
  assert.equal(partial.refusal?.code, "incomplete_write");
  writeFileSync(file, edited);
  const proposed = await settle();
  assert.equal(proposed.state, "queued");
  assert.equal(proposed.changed, 1);
  writeFileSync(join(root, "replacement"), edited);
  renameSync(join(root, "replacement"), file);
  const replacement = await watcher.poll();
  assert.equal(replacement.state, "duplicate");
  let duplicates = 1;
  for (let i = 0; i < 3; i++) { assert.equal((await watcher.poll()).state, "duplicate"); duplicates++; }
  const restarted = new TodoSourceWatcher(config);
  assert.equal((await restarted.runOnce()).state, "duplicate");
  duplicates++;
  writeFileSync(file, "");
  const truncated = await settle();
  assert.equal(truncated.changed, 0);
  assert.equal(truncated.omitted, eligible.length);
  const controller = new AbortController();
  await watcher.run(controller.signal, receipt => { assert.equal(receipt.state, "duplicate"); controller.abort(); });
  const queue = JSON.parse(readFileSync(join(spool, "proposals.json"), "utf8")) as { proposals: { result: { applied: number } }[] };
  assert.equal(queue.proposals.length, 2);
  assert.ok(queue.proposals.every(row => row.result.applied === 0));
  const after = fingerprint(source);
  assert.deepEqual(after, before);
  console.log(JSON.stringify({ items: items.length, sessionEligible: eligible.length, unrepresentable: items.length - eligible.length, sourceFiles: before.files, sourceBytes: Buffer.byteLength(edited), sidecarBytes: Buffer.byteLength(JSON.stringify(baseline.session)), partialRefusals: 1, proposedChanges: proposed.changed, duplicateRevisionsSuppressed: duplicates, truncationOmitted: truncated.omitted, truncationChanges: truncated.changed, pendingAfterShutdown: queue.proposals.length, trackerWrites: 0, sourceUnchanged: true, maxReceiptBytes: Math.max(...[partial, proposed, replacement, truncated].map(row => Buffer.byteLength(JSON.stringify(row)))) }));
} finally { rmSync(root, { recursive: true, force: true }); }
