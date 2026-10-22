/** Sessions use real SDK trackers and compare under core item locks. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLock, create, update, get, init, mutateItem, readSettings } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { packExtension } from "./packed-fixture.ts";
import extension, { createTodoEditingSession, reconcileTodoEditingSession, exportTodoEditingSession, applyTodoEditingSession, serializeTodoTxtLine, type PmItem } from "../index.ts";

const item: PmItem = { id: "task-one", title: "Original", status: "open", priority: 2, tags: ["project"] };

/** Give child imports a separate budget, then bound parsing in a killable child. */
function assertBoundedParsing(source: string): Promise<void> {
  const script = `import assert from 'node:assert/strict';
    import { createTodoEditingSession, reconcileTodoEditingSession, parseTodoTxtLine } from ${JSON.stringify(new URL("../index.ts", import.meta.url).href)};
    const spaces = ' '.repeat(100_000);
    process.send('ready');
    const started = performance.now();
    ${source}
    assert.ok(performance.now() - started < 2_000, 'parsing 100k spaces exceeded two seconds');
    process.send('done');
    process.disconnect();`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    let ready = false, finished = false;
    let timer = setTimeout(() => {
      child.kill();
      reject(new Error("Parser child imports exceeded the startup budget"));
    }, 60_000);
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("message", (message: unknown) => {
      if (message === "done") { finished = true; return; }
      if (message !== "ready") return;
      ready = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        child.kill();
        reject(new Error("Parser exceeded its watchdog after imports completed"));
      }, 15_000);
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && ready && finished) resolve(); else reject(new Error(stderr || `Parser child did not finish its assertions: ${signal ?? code}`));
    });
  });
}

/** Coordinate real writers without relying on elapsed time or scheduler order. */
function barrier(): { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void } {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("session parsing handles 100k spaces and malformed suffixes within a bounded time", async () => {
  await assertBoundedParsing(`
    const item = { id: 'task-one', title: 'Original', status: 'open', priority: 2, tags: [] };
    const {session} = createTodoEditingSession([item]);
    assert.equal(reconcileTodoEditingSession(session, spaces, [item]).ok, true);
    for (const suffix of ['invalid', 'pm-session:task-one!', 'pm-session:' + 'a'.repeat(100_000) + '!']) {
      const result = reconcileTodoEditingSession(session, 'Original' + spaces + suffix, [item]);
      assert.equal(result.refusals[0].code, 'invalid_line');
    }
    const valid = reconcileTodoEditingSession(session, '(C) Original' + spaces + 'pm-session:task-one' + spaces, [item]);
    assert.equal(valid.ok, true);
    assert.equal(valid.changed, 0);
    assert.equal(reconcileTodoEditingSession(session, '(C) Original\\tpm-session:task-one\\t', [item]).ok, true);
    for (const input of ['pm-session:task-one', 'Originalpm-session:task-one', 'Original\\u2028tail pm-session:task-one']) {
      assert.equal(reconcileTodoEditingSession(session, input, [item]).refusals[0].code, 'invalid_line');
    }
    assert.equal(reconcileTodoEditingSession(session, 'Original pm-session:other pm-session:task-one', [item]).refusals[0].code, 'invalid_line');
  `);
});

test("todo.txt prefix parsing handles 100k spaces before a failed body within a bounded time", async () => {
  await assertBoundedParsing(`
    for (const prefix of ['x', '(A)', '2026-01-01', 'x 2026-01-01']) {
      const result = parseTodoTxtLine(prefix + spaces + 'Task\\u2028tail');
      assert.ok(result);
      assert.equal(result.text.includes('Task'), true);
    }
    const ordinary = parseTodoTxtLine('x 2026-01-02 (A) 2026-01-01 Task +project');
    assert.equal(ordinary.done, true);
    assert.equal(ordinary.completionDate, '2026-01-02');
    assert.equal(ordinary.priorityLetter, 'A');
    assert.equal(ordinary.creationDate, '2026-01-01');
    assert.equal(ordinary.text, 'Task');
  `);
});

test("merged source provenance reflects independent priority, tag and deadline changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "todos-merged-source-"));
  const pmRoot = join(root, "tracker");
  try {
    await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
    const created = await create({ title: "Original", type: "Task", priority: 2, tags: "project", author: "test-agent" }, { pmRoot });
    const id = String(created.item.id);
    for (const change of [{ priority: 0 }, { tags: "project,new" }, { deadline: "2026-11-01" }]) {
      const exported = await exportTodoEditingSession(pmRoot);
      const title = String((await get(id, {}, { pmRoot })).item.title);
      const text = exported.text.replace(title, `${title} edited`);
      await update(id, { ...change, author: "test-agent" }, { pmRoot });
      const result = await applyTodoEditingSession(pmRoot, exported.session, text, { author: "test-agent" });
      assert.equal(result.ok, true);
      assert.equal(result.applied, 1);
      const merged = (await get(id, {}, { pmRoot })).item as PmItem;
      assert.equal(merged.title, `${title} edited`);
      assert.equal(merged.todos_todotxt, serializeTodoTxtLine(merged, "fidelity"));
      assert.equal(merged.priority, 0);
      const history = readFileSync(join(pmRoot, "history", `${id}.jsonl`), "utf8");
      assert.equal((await applyTodoEditingSession(pmRoot, exported.session, text, { author: "test-agent" })).changed, 0);
      assert.equal(readFileSync(join(pmRoot, "history", `${id}.jsonl`), "utf8"), history);
    }
    const final = (await get(id, {}, { pmRoot })).item;
    assert.deepEqual([...(final.tags ?? [])].sort(), ["new", "project"]);
    assert.match(String(final.deadline), /^2026-11-01/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("held item lock deterministically rechecks a title changed after preview", async t => {
  const root = mkdtempSync(join(tmpdir(), "todos-held-lock-"));
  const pmRoot = join(root, "tracker");
  const held = barrier(), commit = barrier();
  const contended = barrier(), resume = barrier();
  const previousWait = process.env.PM_LOCK_WAIT_MS;
  let writer: ReturnType<typeof mutateItem> | undefined;
  let applying: ReturnType<typeof applyTodoEditingSession> | undefined;
  try {
    await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
    const created = await create({ title: "Original", type: "Task", author: "test-agent" }, { pmRoot });
    const id = String(created.item.id);
    const exported = await exportTodoEditingSession(pmRoot);
    const settings = await readSettings(pmRoot);
    writer = mutateItem({ pmRoot, settings, id, op: "update", author: "test-agent", async mutate(document) {
      held.resolve();
      await commit.promise;
      document.metadata.title = "Concurrent";
      return { changedFields: ["title"] };
    } });
    void writer.catch(held.reject);
    await held.promise;
    const read = fsp.readFile;
    let observed = false;
    // Observe real lock contention after preview; every read still uses the real FS.
    t.mock.method(fsp, "readFile", async (...args: Parameters<typeof read>) => {
      const value = await read(...args);
      if (String(args[0]) === join(pmRoot, "locks", `${id}.lock`) && !observed) {
        observed = true;
        contended.resolve();
        await resume.promise;
      }
      return value;
    });
    process.env.PM_LOCK_WAIT_MS = "10000";
    applying = applyTodoEditingSession(pmRoot, exported.session, exported.text.replace("Original", "External"), { author: "test-agent" });
    await Promise.race([
      contended.promise,
      applying.then(() => { throw new Error("Apply ended without observing the held item lock"); }),
      delay(10_000, undefined, { ref: false }).then(() => { throw new Error("Held-lock contention was not observed"); }),
    ]);
    commit.resolve();
    await writer;
    const history = readFileSync(join(pmRoot, "history", `${id}.jsonl`), "utf8");
    resume.resolve();
    const result = await applying;
    assert.equal(result.ok, false);
    assert.equal(result.applied, 0);
    assert.equal(result.refusals[0].code, "field_conflict");
    assert.equal(result.refusals[0].field, "title");
    assert.equal((await get(id, {}, { pmRoot })).item.title, "Concurrent");
    assert.equal(readFileSync(join(pmRoot, "history", `${id}.jsonl`), "utf8"), history);
  } finally {
    commit.resolve(); resume.resolve();
    await Promise.allSettled([writer, applying]);
    t.mock.restoreAll();
    if (previousWait === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = previousWait;
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing session text returns a typed actionable preview and apply error", async () => {
  const root = mkdtempSync(join(tmpdir(), "todos-missing-text-"));
  const pmRoot = join(root, "tracker");
  try {
    await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
    const sidecar = join(root, "session.json");
    writeFileSync(sidecar, JSON.stringify(createTodoEditingSession([item]).session));
    const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
    for (const action of ["preview", "apply"]) {
      await assert.rejects(harness.runCommand({ command: "todos session", args: [action], options: { file: join(root, "missing.txt"), session: sidecar }, pmRoot }), { name: "CommandError", message: /Cannot read session todo.txt.*restore.*export/ });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stable digests, reorder, omission and unchanged imports are safe", () => {
  const second = { ...item, id: "task-two" };
  const a = createTodoEditingSession([second, item]);
  const b = createTodoEditingSession([item, second]);
  assert.deepEqual(a, b);
  assert.equal(a.session.entries[0].itemDigest.length, 64);
  const metadata = { ...item, todos_kv: { z: "last", "ä": "unicode", a: "first" } };
  assert.equal(createTodoEditingSession([metadata]).session.digest, createTodoEditingSession([{ ...metadata, todos_kv: { a: "first", z: "last", "ä": "unicode" } }]).session.digest);
  assert.equal(Object.keys(a.session.entries[0].fieldDigests).length, 9);
  assert.deepEqual(reconcileTodoEditingSession(a.session, a.text, [item, second]), { ok: true, changed: 0, applied: 0, unchanged: 2, omitted: 0, refusalCount: 0, refusals: [], hasMore: false });
  assert.equal(reconcileTodoEditingSession(a.session, "", [item, second]).omitted, 2);
  assert.equal(reconcileTodoEditingSession(a.session, a.text.split("\n").reverse().join("\r\n"), [item, second]).unchanged, 2);
});

test("three-way reconciliation conflicts only on externally edited fields", () => {
  const { session, text } = createTodoEditingSession([item]);
  const edited = text.replace("Original", "External");
  assert.equal(reconcileTodoEditingSession(session, edited, [{ ...item, title: "Concurrent" }]).refusals[0].field, "title");
  assert.equal(reconcileTodoEditingSession(session, edited, [{ ...item, priority: 0 }]).ok, true);
  assert.equal(reconcileTodoEditingSession(session, edited, [{ ...item, title: "External", todos_todotxt: edited.split(" pm-session:")[0] }]).changed, 0);
  assert.equal(reconcileTodoEditingSession(session, edited, [{ ...item, todos_todotxt: "Concurrent tokens" }]).refusals[0].field, "todos_todotxt");
  assert.equal(reconcileTodoEditingSession(session, text, [{ ...item, title: "Concurrent" }]).changed, 0);
});

test("untrusted sessions and malformed text return bounded typed remedies", () => {
  const { session, text } = createTodoEditingSession([item]);
  for (const invalid of [null, {}, { ...session, version: 2 }, { ...session, digest: "bad" }, { ...session, entries: [...session.entries, ...session.entries] }]) assert.equal(reconcileTodoEditingSession(invalid, text, [item]).refusals[0].code, "invalid_session");
  for (const [input, code] of [["New task", "invalid_line"], [text + text, "duplicate_id"], [text.replace("task-one", "unknown"), "unknown_id"], [text.replace("Original", "due:2026-02-31 Task"), "invalid_line"], ["x " + text, "lifecycle_required"], [text.replace("Original", "due:bad Task"), "invalid_line"], [text.replace("Original", "pm-session:other Task"), "invalid_line"]]) {
    const result = reconcileTodoEditingSession(session, input, [item]);
    assert.equal(result.ok, false); assert.equal(result.refusals[0].code, code); assert.ok(result.refusals[0].remedy);
  }
  assert.equal(reconcileTodoEditingSession(session, text, []).refusals[0].code, "missing_item");
  const bounded = reconcileTodoEditingSession(session, "invalid\n".repeat(30), [item]);
  assert.equal(bounded.refusalCount, 30); assert.equal(bounded.refusals.length, 20); assert.equal(bounded.hasMore, true);
  for (const bad of [{ ...item, id: "bad id" }, { ...item, title: "multi\nline" }, { ...item, title: "pm-session:reserved" }]) assert.throws(() => createTodoEditingSession([bad]));
  assert.throws(() => createTodoEditingSession([item, item]));
});

test("real non-git tracker: preview, guarded apply, replay and omission preserve history", async () => {
  const root = mkdtempSync(join(tmpdir(), "todos-session-"));
  const pmRoot = join(root, "tracker");
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  try {
    await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
    const created = await create({ title: "Original", type: "Task", priority: 2, tags: "project", author: "test-agent" }, { pmRoot });
    const id = String(created.item.id);
    const exported = await exportTodoEditingSession(pmRoot);
    const text = exported.text.replace("Original", "External");
    assert.equal((await applyTodoEditingSession(pmRoot, exported.session, text, { author: "test-agent", dryRun: true })).changed, 1);
    assert.equal((await get(id, {}, { pmRoot })).item.title, "Original");
    await update(id, { priority: 0, author: "test-agent" }, { pmRoot });
    assert.equal((await applyTodoEditingSession(pmRoot, exported.session, text, { author: "test-agent" })).applied, 1);
    const result = await get(id, {}, { pmRoot });
    assert.equal(result.item.title, "External"); assert.equal(result.item.priority, 0);
    const histories = readdirSync(join(pmRoot, "history")).filter(file => file.endsWith(".jsonl"));
    const history = histories.map(file => readFileSync(join(pmRoot, "history", file), "utf8")).join("");
    assert.equal((await applyTodoEditingSession(pmRoot, exported.session, text, { author: "test-agent" })).changed, 0);
    assert.equal((await applyTodoEditingSession(pmRoot, exported.session, "", { author: "test-agent" })).omitted, 1);
    assert.equal(histories.map(file => readFileSync(join(pmRoot, "history", file), "utf8")).join(""), history);
    const race = await exportTodoEditingSession(pmRoot);
    const racers = await Promise.all([
      applyTodoEditingSession(pmRoot, race.session, race.text.replace("External", "Racer A"), { author: "test-agent" }),
      applyTodoEditingSession(pmRoot, race.session, race.text.replace("External", "Racer B"), { author: "test-agent" }),
    ]);
    assert.equal(racers.filter(result => result.ok).length, 1);
    assert.equal(racers.filter(result => result.refusals.some(refusal => refusal.code === "field_conflict")).length, 1);
    await update(id, { title: "External", assignee: "owner-agent", author: "test-agent" }, { pmRoot });
    const owned = await exportTodoEditingSession(pmRoot);
    const release = await acquireLock(pmRoot, id, 60, "lock-agent");
    const previousWait = process.env.PM_LOCK_WAIT_MS;
    process.env.PM_LOCK_WAIT_MS = "1";
    try {
      const refused = await applyTodoEditingSession(pmRoot, owned.session, owned.text.replace("External", "Forbidden"), { author: "different-agent" });
      assert.equal(refused.refusals[0].code, "write_failed");
    } finally {
      await release();
      if (previousWait === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = previousWait;
    }
    await update(id, { unset: ["assignee"], author: "owner-agent" }, { pmRoot });
    const fresh = await exportTodoEditingSession(pmRoot);
    await update(id, { title: "Concurrent", author: "test-agent" }, { pmRoot });
    assert.equal((await applyTodoEditingSession(pmRoot, fresh.session, fresh.text.replace("External", "Other"), { author: "test-agent" })).refusals[0].code, "field_conflict");
    assert.equal((await applyTodoEditingSession(pmRoot, fresh.session, fresh.text.replace("External", "Other"), { author: "different-agent" })).applied, 0);
    // CLI registration executes the same SDK path against this plain tracker.
    const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
    const command = await harness.runCommand({ command: "todos session", args: ["export"], options: { file: join(root, "todo.txt"), session: join(root, "session.json") }, pmRoot });
    assert.equal((command.result as { exported: number }).exported, 1);
    const preview = await harness.runCommand({ command: "todos session", args: ["preview"], options: { file: join(root, "todo.txt"), session: join(root, "session.json") }, pmRoot });
    assert.equal((preview.result as { unchanged: number }).unchanged, 1);
    await assert.rejects(harness.runCommand({ command: "todos session", args: ["bad"], options: {}, pmRoot }), /Use pm todos session/);
    await assert.rejects(harness.runCommand({ command: "todos session", args: ["preview"], options: { file: "missing", session: "missing" }, pmRoot }), /distinct files/);
    await assert.rejects(harness.runCommand({ command: "todos session", args: ["preview"], options: { file: "file", session: "missing" }, pmRoot }), /Cannot read session JSON/);
    const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");
    const env = { ...process.env, HOME: root, PM_GLOBAL_PATH: join(root, "global"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), PM_TELEMETRY_DISABLED: "1" };
    /** Exercise real installed command parsing and bounded JSON receipts. */
    const cli = (args: string[]): string => execFileSync(pmBin, ["--pm-path", pmRoot, ...args, "--json"], { cwd: root, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    cli(["package", "install", packExtension(root), "--project"]);
    const paths = ["--file", join(root, "installed.txt"), "--session", join(root, "installed.json")];
    assert.equal(JSON.parse(cli(["todos", "session", "export", ...paths])).exported, 1);
    assert.equal(JSON.parse(cli(["todos", "session", "apply", ...paths])).changed, 0);
    assert.match(execFileSync(pmBin, ["--pm-path", pmRoot, "todos", "session", "preview", ...paths], { cwd: root, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }), /unchanged: 1/);
    // PATH excludes git entirely: export/session reconciliation uses no subprocess.
    const source = `import { exportTodoEditingSession, applyTodoEditingSession } from ${JSON.stringify(join(process.cwd(), "index.ts"))}; const e = await exportTodoEditingSession(${JSON.stringify(pmRoot)}); const r = await applyTodoEditingSession(${JSON.stringify(pmRoot)},e.session,e.text.replace('Concurrent','No Git edit'),{author:'test-agent'}); if(!r.ok || r.applied !== 1)process.exit(1);`;
    execFileSync(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, PATH: root }, cwd: root });
  } finally {
    if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
    rmSync(root, { recursive: true, force: true });
  }
});

test("export rejects lossy titles and identifies every unrepresentable item", () => {
  for (const title of ["Meeting at 10:30", "Work +sdk", "Call @home", "Keep note:x", "2026-01-01 Task", "multi\nline", "pm-session:reserved", "due:2026-02-31 Task", ""]) {
    assert.throws(() => createTodoEditingSession([{ ...item, title }]), { name: "TypeError", message: /Item task-one.*JSONL export/ }, title);
  }
  for (const title of ["x Task", "(A) Task"]) assert.throws(() => createTodoEditingSession([{ ...item, priority: undefined, title }]), /Item task-one.*parsing would alter/);
  assert.throws(() => createTodoEditingSession([{ ...item, deadline: "2026-02-31" }]), /Item task-one.*calendar dates/);
  const safe = createTodoEditingSession([{ ...item, title: "  Ordinary   task  " }]);
  assert.equal(reconcileTodoEditingSession(safe.session, safe.text, [{ ...item, title: "  Ordinary   task  " }]).changed, 0);
  // Fidelity provenance must not hide the same loss after a tracker-side title edit.
  assert.throws(() => createTodoEditingSession([{ ...item, title: "Work +sdk", todos_todotxt: "Original +project" }]), /Item task-one.*parsing would alter/);
});

test("failed session exports clean up owned files and permit retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "todos-export-failure-"));
  const pmRoot = join(root, "tracker");
  try {
    await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
    await create({ title: "Export fixture", type: "Task", author: "test-agent" }, { pmRoot });
    const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
    const file = join(root, "missing", "todo.txt"), sidecar = join(root, "session.json");
    const run = () => harness.runCommand({ command: "todos session", args: ["export"], options: { file, session: sidecar }, pmRoot });
    const failed = await run();
    assert.equal(failed.handled, false);
    assert.match(failed.errorMessage ?? "", /ENOENT/);
    assert.equal(existsSync(sidecar), false);
    mkdirSync(dirname(file));
    await run();
    const originalText = readFileSync(file, "utf8"), originalSidecar = readFileSync(sidecar, "utf8");
    await assert.rejects(run(), /already exists/);
    assert.equal(readFileSync(file, "utf8"), originalText);
    assert.equal(readFileSync(sidecar, "utf8"), originalSidecar);
    rmSync(file);
    await assert.rejects(run(), /already exists/);
    assert.equal(readFileSync(sidecar, "utf8"), originalSidecar);
    rmSync(sidecar);
    writeFileSync(file, "Existing editing work");
    await assert.rejects(run(), /already exists/);
    assert.equal(readFileSync(file, "utf8"), "Existing editing work");
    assert.equal(existsSync(sidecar), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mixed known input refusals prevent all item and history writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "todos-mixed-batch-"));
  const pmRoot = join(root, "tracker");
  try {
    await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
    const first = await create({ title: "First original", type: "Task", author: "test-agent" }, { pmRoot });
    const second = await create({ title: "Second original", type: "Task", author: "test-agent" }, { pmRoot });
    const exported = await exportTodoEditingSession(pmRoot);
    const ids = [String(first.item.id), String(second.item.id)];
    const history = ids.map(id => readFileSync(join(pmRoot, "history", `${id}.jsonl`), "utf8"));
    const rows = exported.text.trimEnd().split("\n");
    const text = [rows.find(line => line.endsWith(`pm-session:${ids[0]}`))!.replace("First original", "First edited"), `x ${rows.find(line => line.endsWith(`pm-session:${ids[1]}`))!}`].join("\n");
    const result = await applyTodoEditingSession(pmRoot, exported.session, text, { author: "test-agent" });
    assert.equal(result.ok, false);
    assert.equal(result.applied, 0);
    assert.equal(result.refusals[0].code, "lifecycle_required");
    assert.equal((await get(ids[0], {}, { pmRoot })).item.title, "First original");
    assert.equal((await get(ids[1], {}, { pmRoot })).item.title, "Second original");
    assert.deepEqual(ids.map(id => readFileSync(join(pmRoot, "history", `${id}.jsonl`), "utf8")), history);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("multi-item apply scans the input once outside locks and preserves duplicate refusal", async t => {
  const root = mkdtempSync(join(tmpdir(), "todos-indexed-apply-"));
  const pmRoot = join(root, "tracker");
  try {
    await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
    for (let index = 0; index < 4; index++) await create({ title: `Original ${index}`, type: "Task", author: "test-agent" }, { pmRoot });
    const { session, text } = await exportTodoEditingSession(pmRoot);
    const edited = text.replaceAll("Original", "Edited");
    const split = String.prototype.split;
    let scans = 0;
    const spy = t.mock.method(String.prototype, "split", function (this: string, ...args: Parameters<typeof split>) {
      if (this === edited) scans++;
      return split.apply(this, args);
    });
    const result = await applyTodoEditingSession(pmRoot, session, edited, { author: "test-agent" });
    spy.mock.restore();
    assert.equal(result.applied, 4);
    assert.ok(scans <= 2, `full input scans must not grow with patch count: ${scans}`);
    const duplicate = await applyTodoEditingSession(pmRoot, session, edited + edited.split("\n")[0], { author: "test-agent" });
    assert.equal(duplicate.refusals[0].code, "duplicate_id");
    assert.equal(duplicate.applied, 0);
    for (const entry of session.entries) assert.match(String((await get(entry.id, {}, { pmRoot })).item.title), /^Edited /);
  } finally { t.mock.restoreAll(); rmSync(root, { recursive: true, force: true }); }
});

test("validation script counts exported entries when an untitled item is ineligible", async () => {
  const root = mkdtempSync(join(tmpdir(), "todos-validation-"));
  const pmRoot = join(root, "tracker");
  try {
    await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
    await create({ title: "Eligible task", type: "Task", author: "test-agent" }, { pmRoot });
    const untitled = await create({ title: "Untitled fixture", type: "Task", author: "test-agent" }, { pmRoot });
    const file = join(pmRoot, "tasks", `${untitled.item.id}.toon`);
    writeFileSync(file, readFileSync(file, "utf8").replace("title: Untitled fixture", 'title: ""'));
    const receipt = JSON.parse(execFileSync(process.execPath, ["scripts/validate-sessions.ts", pmRoot], { cwd: process.cwd(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
    assert.equal(receipt.items, 2);
    assert.equal(receipt.exported, 1);
    assert.equal(receipt.omitted, 1);
    assert.equal(receipt.sourceUnchanged, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("partial sidecar and text write failures remove only newly created outputs", async t => {
  const root = mkdtempSync(join(tmpdir(), "todos-partial-export-"));
  const pmRoot = join(root, "tracker");
  try {
    await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
    await create({ title: "Partial export fixture", type: "Task", author: "test-agent" }, { pmRoot });
    const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
    const file = join(root, "todo.txt"), sidecar = join(root, "session.json");
    const write = fs.writeFileSync;
    for (const failAt of [1, 2]) {
      let writes = 0;
      const failure = new Error("simulated partial output failure");
      const spy = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
        if (typeof args[0] === "number" && ++writes === failAt) {
          write(args[0], "partial");
          throw failure;
        }
        return write(...args);
      });
      syncBuiltinESMExports();
      try {
        const failed = await harness.runCommand({ command: "todos session", args: ["export"], options: { file, session: sidecar }, pmRoot });
        assert.equal(failed.handled, false);
        assert.equal(failed.errorMessage, failure.message);
        assert.equal(existsSync(file), false);
        assert.equal(existsSync(sidecar), false);
      } finally { spy.mock.restore(); syncBuiltinESMExports(); }
    }
    await harness.runCommand({ command: "todos session", args: ["export"], options: { file, session: sidecar }, pmRoot });
    assert.match(readFileSync(file, "utf8"), /Partial export fixture/);
    assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).entries.length, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});
