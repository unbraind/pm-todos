/** Watcher regression cases use real SDK trackers outside git, with no SDK mocks. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { packExtension } from "./packed-fixture.ts";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { init, create, get, update } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { TodoSourceWatcher, exportTodoEditingSession, type TodoWatcherOptions, type TodoWatcherReceipt, type TodoChangeProposal } from "../index.ts";

/** Wait for the configured stability window using real time and filesystem reads. */
async function settle(watcher: TodoSourceWatcher): Promise<TodoWatcherReceipt> {
  await watcher.poll();
  await delay(5);
  return watcher.poll();
}

test("authorized file watcher proposals are stable, bounded, revision-bound and durable without git", async t => {
  const root = mkdtempSync(join(tmpdir(), "todos-watch-"));
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  const pmRoot = join(root, "tracker");
  const file = join(root, "todo.txt"), sessionFile = join(root, "session.json");
  try {
    await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
    const first = await create({ title: "First task", type: "Task", author: "test-agent" }, { pmRoot });
    await create({ title: "Second task", type: "Task", author: "test-agent" }, { pmRoot });
    const baseline = await exportTodoEditingSession(pmRoot);
    const edited = baseline.text.replace("First task", "Edited task");
    const historyPath = join(pmRoot, "history", `${first.item.id}.jsonl`);
    const historyBefore = readFileSync(historyPath, "utf8");
    writeFileSync(sessionFile, JSON.stringify(baseline.session));
    let sequence = 0;
    /** Isolate queue state while reusing the real read-only tracker. */
    const config = (overrides: Partial<TodoWatcherOptions> = {}): TodoWatcherOptions => ({ pmRoot, file, sessionFile, spool: join(root, `queue-${sequence++}`), stableMs: 1, pollMs: 1, ...overrides });
    /** Read the persisted proposal payload, separate from the compact receipt. */
    const queue = (value: TodoWatcherOptions): TodoChangeProposal[] => (JSON.parse(readFileSync(join(value.spool, "proposals.json"), "utf8")) as { proposals: TodoChangeProposal[] }).proposals;

    await t.test("partial writes reset stability; malformed tails never produce proposals", async st => {
      writeFileSync(file, edited.slice(0, -5));
      let now = 0;
      const clock = st.mock.method(performance, "now", () => now);
      const value = config({ stableMs: 20 });
      const watcher = new TodoSourceWatcher(value);
      assert.equal((await watcher.poll()).state, "waiting");
      assert.equal((await watcher.poll()).state, "waiting");
      now = 25;
      assert.equal((await watcher.poll()).refusal?.code, "incomplete_write");
      writeFileSync(file, edited);
      assert.equal((await watcher.poll()).state, "waiting");
      now = 50;
      assert.equal((await watcher.poll()).state, "queued");
      clock.mock.restore();
      assert.equal(queue(value).length, 1);
      assert.equal(queue(value)[0].patches[0].values.title, "Edited task");
    });
    await t.test("truncation retains all baseline identities and cannot propose deletion", async () => {
      const value = config();
      writeFileSync(file, "");
      const result = await settle(new TodoSourceWatcher(value));
      assert.equal(result.state, "queued");
      assert.equal(result.omitted, 2);
      assert.deepEqual(queue(value)[0].patches, []);
      const oneLine = edited.split("\n").find(line => line.includes("Edited task"))! + "\n";
      writeFileSync(file, oneLine);
      const receipt = await settle(new TodoSourceWatcher(value));
      assert.equal(receipt.omitted, 1);
      assert.equal(receipt.changed, 1);
      assert.ok(queue(value).every(row => row.result.applied === 0));
    });
    await t.test("SDK queue lock deduplicates concurrent watcher instances", async () => {
      const value = config();
      const left = new TodoSourceWatcher(value), right = new TodoSourceWatcher(value);
      await Promise.all([left.poll(), right.poll()]);
      await delay(5);
      const results = await Promise.all([left.poll(), right.poll()]);
      assert.deepEqual(results.map(row => row.state).sort(), ["duplicate", "queued"]);
      assert.equal(queue(value).length, 1);
    });
    await t.test("same-instance overlapping samples refuse cleanly", async () => {
      const watcher = new TodoSourceWatcher(config());
      const firstPoll = watcher.poll();
      assert.equal((await watcher.poll()).refusal?.code, "source_unstable");
      await firstPoll;
    });
    await t.test("untrusted long identities cannot expand the compact refusal output", async () => {
      writeFileSync(file, `Task pm-session:${"a".repeat(10000)}\n`);
      const receipt = await settle(new TodoSourceWatcher(config()));
      assert.equal(receipt.refusal?.code, "plan_refused");
      assert.equal(receipt.result?.refusals[0].id, undefined);
      assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 1000);
      writeFileSync(file, edited);
    });
    await t.test("queue backpressure preserves prior proposals", async () => {
      const value = config({ maxPending: 1 });
      const watcher = new TodoSourceWatcher(value);
      assert.equal((await settle(watcher)).state, "queued");
      const before = readFileSync(join(value.spool, "proposals.json"), "utf8");
      writeFileSync(file, edited.replace("Edited", "Another"));
      assert.equal((await settle(watcher)).refusal?.code, "queue_full");
      assert.equal(readFileSync(join(value.spool, "proposals.json"), "utf8"), before);
      writeFileSync(file, edited);
    });
    await t.test("change cap refuses the whole plan with a remedy", async () => {
      writeFileSync(file, edited.replace("Second task", "Another task"));
      const receipt = await settle(new TodoSourceWatcher(config({ maxChanges: 1 })));
      assert.equal(receipt.refusal?.code, "change_limit");
      assert.ok(receipt.refusal.remedy.length > 20);
      writeFileSync(file, edited);
    });
    await t.test("invalid options do no I/O", async () => {
      for (const override of [{ file: "" }, { stableMs: 0 }, { maxChanges: 1001 }, { maxBytes: NaN }, { sessionFile: file }, { spool: pmRoot }, { spool: join(pmRoot, "inside") }, { spool: join(pmRoot, "..hidden") }]) {
        assert.equal((await new TodoSourceWatcher(config(override)).poll()).refusal?.code, "invalid_options");
      }
    });
    await t.test("missing, nonregular, symlink and over-budget sources refuse", async () => {
      assert.equal((await new TodoSourceWatcher(config({ file: join(root, "absent") })).poll()).refusal?.code, "source_unavailable");
      assert.equal((await new TodoSourceWatcher(config({ file: root })).poll()).refusal?.code, "source_unavailable");
      symlinkSync(file, join(root, "linked"));
      assert.equal((await new TodoSourceWatcher(config({ file: join(root, "linked") })).poll()).refusal?.code, "source_unavailable");
      assert.equal((await new TodoSourceWatcher(config({ maxBytes: 1 })).poll()).refusal?.code, "source_too_large");
      writeFileSync(join(root, "bad-utf8"), Buffer.from([0xff]));
      assert.equal((await new TodoSourceWatcher(config({ file: join(root, "bad-utf8") })).poll()).refusal?.code, "source_unavailable");
    });
    await t.test("bad sidecars, trackers and lifecycle changes return typed refusals", async () => {
      assert.equal((await settle(new TodoSourceWatcher(config({ sessionFile: join(root, "missing") })))).refusal?.code, "session_unavailable");
      writeFileSync(join(root, "invalid.json"), "{}");
      assert.equal((await settle(new TodoSourceWatcher(config({ sessionFile: join(root, "invalid.json") })))).refusal?.code, "plan_refused");
      writeFileSync(join(root, "malformed.json"), "{");
      assert.equal((await settle(new TodoSourceWatcher(config({ sessionFile: join(root, "malformed.json") })))).refusal?.code, "session_unavailable");
      assert.equal((await settle(new TodoSourceWatcher(config({ pmRoot: join(root, "absent-tracker") })))).refusal?.code, "tracker_unavailable");
      writeFileSync(file, edited.replace(/^(.*)$/m, "x $1"));
      const result = await settle(new TodoSourceWatcher(config()));
      assert.equal(result.refusal?.code, "plan_refused");
      assert.equal(result.result?.refusals[0].code, "lifecycle_required");
      writeFileSync(file, edited);
    });
    await t.test("damaged or differently bound queues are never overwritten", async () => {
      const value = config();
      await settle(new TodoSourceWatcher(value));
      const saved = readFileSync(join(value.spool, "proposals.json"), "utf8");
      const corrupt = JSON.parse(saved) as { binding: string };
      corrupt.binding = "different-source";
      writeFileSync(join(value.spool, "proposals.json"), JSON.stringify(corrupt));
      assert.equal((await settle(new TodoSourceWatcher(value))).refusal?.code, "spool_mismatch");
      writeFileSync(join(value.spool, "proposals.json"), "{");
      assert.equal((await settle(new TodoSourceWatcher(value))).refusal?.code, "spool_unavailable");
      writeFileSync(join(value.spool, "proposals.json"), saved);
      const corruptRow = JSON.parse(saved) as { proposals: TodoChangeProposal[] };
      corruptRow.proposals[0].text += "corrupt";
      writeFileSync(join(value.spool, "proposals.json"), JSON.stringify(corruptRow));
      assert.equal((await settle(new TodoSourceWatcher(value))).refusal?.code, "spool_mismatch");
      writeFileSync(join(root, "not-dir"), "occupied");
      assert.equal((await settle(new TodoSourceWatcher(config({ spool: join(root, "not-dir") })))).refusal?.code, "spool_unavailable");
    });
    await t.test("cancellation preserves accepted proposal and restart deduplicates", async () => {
      const value = config();
      const watcher = new TodoSourceWatcher(value);
      const controller = new AbortController();
      const receipts: TodoWatcherReceipt[] = [];
      await watcher.run(controller.signal, receipt => {
        receipts.push(receipt);
        if (receipt.state === "queued") controller.abort();
      });
      assert.equal(receipts[0].state, "waiting");
      assert.equal(receipts.at(-1)?.state, "queued");
      assert.equal(queue(value).length, 1);
      assert.equal((await settle(new TodoSourceWatcher(value))).state, "duplicate");
      await watcher.run(controller.signal, () => assert.fail("aborted run must not sample"));
      const waiting = new AbortController();
      const running = watcher.run(waiting.signal, () => { setTimeout(() => waiting.abort(), 1); });
      await running;
    });
    await t.test("command exposes one bounded cycle and typed refusal through the SDK harness", async () => {
      const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
      const value = config();
      const response = await harness.runCommand({ command: "todos watch", pmRoot, args: [], options: { file, session: sessionFile, spool: value.spool, "stable-ms": "1", "max-bytes": "1048576", maxChanges: "100", maxPending: "20", pollMs: "1" } });
      assert.equal((response.result as TodoWatcherReceipt).state, "queued");
      const exit = process.exitCode;
      try {
        const refused = await harness.runCommand({ command: "todos watch", pmRoot, args: [], options: {} });
        assert.equal((refused.result as TodoWatcherReceipt).refusal?.code, "invalid_options");
      } finally { process.exitCode = exit; }
    });
    await t.test("follow command streams SDK NDJSON and removes signal handlers", async () => {
      const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
      const before = process.listenerCount("SIGTERM");
      const value = config();
      const output: TodoWatcherReceipt[] = [];
      const write = process.stdout.write.bind(process.stdout);
      const spy = t.mock.method(process.stdout, "write", (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        const text = String(chunk);
        if (text.startsWith('{"ok":')) {
          const receipt = JSON.parse(text) as TodoWatcherReceipt;
          output.push(receipt);
          if (receipt.state === "queued" || receipt.refusal?.code === "invalid_options") process.emit("SIGTERM");
          return true;
        }
        return write(chunk);
      });
      const exit = process.exitCode;
      try {
        await harness.runCommand({ command: "todos watch", pmRoot, args: [], options: { file, session: sessionFile, spool: value.spool, stableMs: 1, pollMs: 1, follow: true } });
        await harness.runCommand({ command: "todos watch", pmRoot, args: [], options: { follow: true } });
      } finally { spy.mock.restore(); process.exitCode = exit; }
      assert.ok(output.some(row => row.state === "queued"));
      assert.ok(output.some(row => row.refusal?.code === "invalid_options"));
      assert.equal(process.listenerCount("SIGTERM"), before);
    });
    await t.test("installed CLI works with PATH excluding git and SIGTERM preserves its queue", async () => {
      const pmBin = join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
      const env = { ...process.env, HOME: root, PM_GLOBAL_PATH: join(root, "global"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), PM_TELEMETRY_DISABLED: "1" };
      execFileSync(process.execPath, [pmBin, "--pm-path", pmRoot, "package", "install", packExtension(root), "--project", "--json"], { cwd: root, env, stdio: "pipe" });
      const value = config();
      const args = [pmBin, "--pm-path", pmRoot, "todos", "watch", "--file", file, "--session", sessionFile, "--spool", value.spool, "--stable-ms", "1"];
      const withoutGit = { ...env, PATH: root };
      const one = JSON.parse(execFileSync(process.execPath, [...args, "--json"], { cwd: root, env: withoutGit, encoding: "utf8", stdio: "pipe" })) as TodoWatcherReceipt;
      assert.equal(one.state, "queued");
      const toon = execFileSync(process.execPath, args, { cwd: root, env: withoutGit, encoding: "utf8", stdio: "pipe" });
      assert.match(toon, /state:.*duplicate/);
      const follow = config();
      const followArgs = [...args];
      followArgs[followArgs.indexOf(value.spool)] = follow.spool;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [...followArgs, "--follow"], { cwd: root, env: withoutGit, stdio: ["ignore", "pipe", "pipe"] });
        let output = "", error = "", queued = false;
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("watch CLI timed out")); }, 60_000);
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (!queued && output.includes('"state":"queued"')) { queued = true; child.kill("SIGTERM"); }
        });
        child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          if (code === 0 && signal === null && queued) resolve(); else reject(new Error(`watch stopped with ${code}/${signal}: ${error}`));
        });
      });
      assert.equal(queue(follow).length, 1);
      assert.equal((await settle(new TodoSourceWatcher(follow))).state, "duplicate");
    });
    assert.equal((await get(String(first.item.id), {}, { pmRoot })).item.title, "First task");
    assert.equal(readFileSync(historyPath, "utf8"), historyBefore);
    assert.ok(!readdirSync(root).includes(".git"));
    await t.test("tracker edits change the bound revision and conflicting fields refuse", async () => {
      const value = config();
      const firstReceipt = await settle(new TodoSourceWatcher(value));
      await update(String(first.item.id), { description: "Independent field", author: "test-agent" }, { pmRoot });
      const nextReceipt = await settle(new TodoSourceWatcher(value));
      assert.equal(nextReceipt.state, "queued");
      assert.notEqual(nextReceipt.proposalId, firstReceipt.proposalId);
      await update(String(first.item.id), { title: "Concurrent title", author: "test-agent" }, { pmRoot });
      const receipt = await settle(new TodoSourceWatcher(config()));
      assert.equal(receipt.refusal?.code, "plan_refused");
      assert.ok(receipt.result?.refusals.some(row => row.code === "field_conflict"));
    });
  } finally {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    rmSync(root, { recursive: true, force: true });
  }
});

/** Standalone regression permits a behavioural revert without running unrelated cases. */
test("watcher replacement and restart deduplicate durable revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "todos-watch-replay-"));
  const pmRoot = join(root, "tracker");
  try {
    await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
    await create({ title: "Original title", type: "Task", author: "test-agent" }, { pmRoot });
    const baseline = await exportTodoEditingSession(pmRoot);
    const file = join(root, "todo.txt"), sessionFile = join(root, "baseline.json");
    writeFileSync(file, baseline.text.replace("Original title", "Edited title"));
    writeFileSync(sessionFile, JSON.stringify(baseline.session));
    const value = { pmRoot, file, sessionFile, spool: join(root, "queue"), stableMs: 1 };
    const watcher = new TodoSourceWatcher(value);
    const first = await settle(watcher);
    assert.equal(first.state, "queued");
    writeFileSync(join(root, "replacement"), readFileSync(file));
    renameSync(join(root, "replacement"), file);
    assert.equal((await watcher.poll()).state, "duplicate");
    assert.equal((await settle(new TodoSourceWatcher(value))).state, "duplicate");
    const rows = (JSON.parse(readFileSync(join(value.spool, "proposals.json"), "utf8")) as { proposals: TodoChangeProposal[] }).proposals;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, first.proposalId);
    for (const revision of [rows[0].sourceRevision, rows[0].sessionRevision, rows[0].trackerRevision]) assert.match(revision, /^[a-f0-9]{64}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
