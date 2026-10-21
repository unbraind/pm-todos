/** Sessions use real SDK trackers and compare under core item locks. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { acquireLock, create, update, get, init } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { packExtension } from "./packed-fixture.ts";
import extension, { createTodoEditingSession, reconcileTodoEditingSession, exportTodoEditingSession, applyTodoEditingSession, type PmItem } from "../index.ts";

const item: PmItem = { id: "task-one", title: "Original", status: "open", priority: 2, tags: ["project"] };

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
  for (const [input, code] of [["New task", "invalid_line"], [text + text, "duplicate_id"], [text.replace("task-one", "unknown"), "unknown_id"], [text.replace("Original", "due:2026-02-31"), "invalid_line"], ["x " + text, "lifecycle_required"], [text.replace("Original", "due:bad Task"), "invalid_line"], [text.replace("Original", "pm-session:other Task"), "invalid_line"]]) {
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
    const source = `import { exportTodoEditingSession, applyTodoEditingSession } from ${JSON.stringify(join(process.cwd(), "index.ts"))}; const e = await exportTodoEditingSession(${JSON.stringify(pmRoot)}); const r = await applyTodoEditingSession(${JSON.stringify(pmRoot)},e.session,e.text,{author:'test-agent'}); if(!r.ok || r.changed)process.exit(1);`;
    execFileSync(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, PATH: root }, cwd: root });
  } finally {
    if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
    rmSync(root, { recursive: true, force: true });
  }
});
