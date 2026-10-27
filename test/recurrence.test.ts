/** Real SDK recurrence, replay and deterministic competing-writer regressions. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PmClient, locateItem, readLocatedItem, readSettings, resolveRuntimeStatusRegistry, readHistoryEntries, getHistoryPath, resolveIsoOrRelative, type PmCreateActionOptions, type PmUpdateActionOptions } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness, decodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension, { applyTodoOccurrence, previewTodoOccurrence, type TodoRecurrenceResult, type TodoRecurrenceTransition, type TodoOccurrenceSchedule, type TodoRecurrenceRequest } from "../index.ts";
import { packExtension } from "./packed-fixture.ts";

/** Install the packed artifact on a plain tracker, with no discoverable git parent. */
async function fixture(t: test.TestContext, sourceRoot = process.cwd()) {
  const root = mkdtempSync(join(tmpdir(), "todos-recurrence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, "tracker");
  const env = { ...process.env, HOME: root, PM_AUTHOR: "test-agent", PM_GLOBAL_PATH: join(root, "global"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), PM_TELEMETRY_DISABLED: "1", GIT_CEILING_DIRECTORIES: dirname(root) };
  const cli = join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  /** Launch the actual host; optionally remove git and pm from executable lookup. */
  const command = (args: string[], restricted = false): string => execFileSync(process.execPath, [cli, "--pm-path", pmRoot, ...args], { cwd: root, env: { ...env, ...(restricted ? { PATH: join(root, "bin") } : {}) }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  command(["init", "--prefix", "fixture", "--defaults", "--agent-guidance", "skip", "--json"]);
  const tarball = packExtension(root, sourceRoot);
  command(["package", "install", tarball, "--project", "--json"]);
  mkdirSync(join(root, "bin"));
  copyFileSync(process.execPath, join(root, "bin", basename(process.execPath)));
  const client = new PmClient({ pmRoot, cwd: root, author: "test-agent" });
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
  /** Create a completed native fidelity source without hand-normalizing SDK state. */
  const source = async (suffix: string, options: PmCreateActionOptions = {}) => {
    const line = "x 2026-10-25 (B) Weekly +project @context rec:+1w due:2026-10-20";
    return (await client.create({ id: "source-" + suffix.replaceAll("_", "-"), type: "Task", title: "Weekly", status: "closed", closeReason: "Completed test work", deadline: "2026-10-20", priority: 1, tags: "project,context", field: ["todos_todotxt=" + line, 'todos_kv={"rec":"+1w"}', "todos_completion_date=2026-10-25"], ...options })).item.id;
  };
  return { root, pmRoot, client, harness, source, env, cli, command, tarball };
}

/** Install the same discovered artifact into the independent reference tracker. */
async function referenceFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const referenceRoot = join(f.root, "reference");
  const reference = new PmClient({ pmRoot: referenceRoot, cwd: f.root, author: "test-agent" });
  await reference.init("fixture", { defaults: true, agentGuidance: "skip" });
  await reference.packageInstall(f.tarball, { project: true });
  return { referenceRoot, reference };
}

test("release version bump packs and installs the actual artifact in both trackers", async t => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "todos-release-bump-"));
  t.after(() => rmSync(sourceRoot, { recursive: true, force: true }));
  for (const file of ["package.json", "manifest.json", "dist"]) {
    cpSync(join(process.cwd(), file), join(sourceRoot, file), { recursive: true });
  }
  const packageFile = join(sourceRoot, "package.json");
  const metadata = JSON.parse(readFileSync(packageFile, "utf8")) as { version: string };
  const [major, minor, patch] = metadata.version.split(".");
  metadata.version = `${major}.${minor}.${Number(patch) + 1}`;
  writeFileSync(packageFile, JSON.stringify(metadata));
  const f = await fixture(t, sourceRoot);
  const { referenceRoot } = await referenceFixture(f);
  for (const tracker of [f.pmRoot, referenceRoot]) {
    const installed = JSON.parse(readFileSync(join(tracker, "extensions", "pm-todos", "package.json"), "utf8")) as { version: string };
    assert.equal(installed.version, metadata.version);
  }
});
const dialect = "todotxt-weekly-v1" as const;
/** Assert the public result cannot emit invalid numeric values or grow with the tracker. */
function receipt(result: TodoRecurrenceResult): void {
  assert.ok(Number.isFinite(result.created) && [0, 1].includes(result.created));
  assert.ok(Number.isFinite(result.updated ?? 0) && [0, 1].includes(result.updated ?? 0));
  assert.ok(JSON.stringify(result).length < 1800);
  if (!result.ok) assert.ok(result.code && result.remedy);
}

test("weekly completion is previewed, applied once and chained with stable identities", async t => {
  const f = await fixture(t);
  const id = await f.source("weekly");
  const before = await f.client.get(id);
  const bytes = readFileSync(join(f.pmRoot, "history", id + ".jsonl"), "utf8");
  const input = { id, dialect };
  const preview = await previewTodoOccurrence(f.pmRoot, input);
  assert.equal(preview.action, "preview");
  assert.equal(preview.intended?.originalDue, "2026-10-20");
  assert.equal(preview.intended?.deadline, "2026-10-27T00:00:00.000Z");
  receipt(preview);
  const applied = await applyTodoOccurrence(f.pmRoot, { ...input, expectedRevision: preview.revision }, { author: "test-agent" });
  assert.equal(applied.action, "created");
  assert.equal(applied.created, 1);
  const next = (await f.client.get(preview.nextId!)).item;
  assert.equal(next.deadline, "2026-10-27T00:00:00.000Z");
  assert.equal(next.status, "open");
  assert.equal((next.todos_kv as Record<string, string>).pmoriginaldue, "2026-10-20");
  assert.equal((next.todos_kv as Record<string, string>).pmprevious, id);
  assert.match(String(next.todos_todotxt), /rec:\+1w due:2026-10-27/);
  assert.doesNotMatch(String(next.todos_todotxt), /^x /);
  assert.deepEqual((await f.client.get(id)).item, before.item);
  assert.equal(readFileSync(join(f.pmRoot, "history", id + ".jsonl"), "utf8"), bytes);
  assert.equal((await applyTodoOccurrence(f.pmRoot, { ...input, expectedRevision: preview.revision }, { author: "test-agent" })).action, "unchanged");
  await f.client.comments(id, { add: "A later observation" });
  assert.equal((await applyTodoOccurrence(f.pmRoot, { ...input, expectedRevision: preview.revision }, { author: "test-agent" })).code, "source_conflict");
  const fresh = await previewTodoOccurrence(f.pmRoot, input);
  assert.equal(fresh.nextId, preview.nextId);
  assert.equal(fresh.action, "unchanged");
  assert.equal((await applyTodoOccurrence(f.pmRoot, { ...input, expectedRevision: fresh.revision }, { author: "test-agent" })).action, "unchanged");
  await f.client.close(preview.nextId!, "Next weekly completion");
  const chained = await previewTodoOccurrence(f.pmRoot, { id: preview.nextId!, dialect });
  assert.equal(chained.series, preview.series);
  assert.equal(chained.intended?.deadline, "2026-11-03T00:00:00.000Z");
  assert.notEqual(chained.occurrence, preview.occurrence);
});

test("strict boundary, disabled bytes, dates, timezone and configured status roles", async t => {
  const f = await fixture(t);
  const id = await f.source("policy");
  const snapshot = (await f.client.get(id)).item;
  const invalid: unknown[] = [null, [], Array(3), "text", 1, Infinity, { id, dialect, extra: [] }, { id: "x".repeat(161) }, { id, dialect: "weekly" }, { id, expectedRevision: "old" }, { id: NaN }, { id, expectedTargetRevision: Infinity }, { id, expectedTargetRevision: Array(3) }, { id, expectedTargetRevision: "old" }];
  for (let n = 0; n < 200; n++) invalid.push({ id, expectedRevision: [NaN, -Infinity, Infinity, -1, Number.MAX_VALUE, [], Array(10), {}, "x".repeat(n)][n % 9] });
  for (const value of invalid) { const result = await previewTodoOccurrence(f.pmRoot, value); assert.equal(result.ok, false); receipt(result); }
  for (const timezone of ["Europe/Vienna", "UTC", "+02:00", Infinity, Array(5)]) assert.equal((await previewTodoOccurrence(f.pmRoot, { id, dialect, timezone })).code, "unsupported_timezone");
  assert.equal((await previewTodoOccurrence("missing-tracker", { id })).action, "disabled");
  assert.equal((await applyTodoOccurrence(f.pmRoot, { id }, { author: "test-agent" })).action, "disabled");
  assert.deepEqual((await f.client.get(id)).item, snapshot);
  assert.equal((await applyTodoOccurrence(f.pmRoot, { id, dialect }, { author: "test-agent" })).code, "invalid_input");
  assert.equal((await previewTodoOccurrence(f.pmRoot, { id: "missing", dialect })).code, "missing_item");
  for (const due of ["2026-02-30", "2026-13-01", "0000-01-01", "9999-12-31", "2026-03-29T01:00:00+01:00"]) {
    const row = await f.source("date-" + due.replace(/[^0-9]/g, ""), { deadline: "2026-10-20", field: [`todos_todotxt=x Weekly rec:+1w due:${due}`, 'todos_kv={"rec":"+1w"}'] });
    const result = await previewTodoOccurrence(f.pmRoot, { id: row, dialect });
    assert.equal(result.ok, false); receipt(result);
  }
  const overflow = await f.source("overflow", { deadline: "9999-12-31", field: ["todos_todotxt=x Weekly rec:+1w due:9999-12-31", 'todos_kv={"rec":"+1w"}'] });
  assert.equal((await previewTodoOccurrence(f.pmRoot, { id: overflow, dialect })).code, "invalid_date");
  for (const [suffix, rec, due, code] of [["bad", "1m", "2026-10-20", "unsupported_recurrence"], ["roll", "+1w", "2026-02-30", "invalid_date"], ["missing-completion", "1w", "2026-10-20", "invalid_date"], ["duplicate", "+1w rec:+2w", "2026-10-20", "invalid_source"]]) {
    const row = await f.source(suffix, { deadline: due === "2026-02-30" ? "2026-03-02" : due, field: [`todos_todotxt=x Weekly rec:${rec} due:${due}`, `todos_kv=${JSON.stringify({ rec: rec.split(" ").at(-1)!.replace("rec:", "") })}`] });
    assert.equal((await previewTodoOccurrence(f.pmRoot, { id: row, dialect })).code, code);
  }
  const completion = await f.source("completion", { field: ["todos_todotxt=x 2026-10-25 Weekly rec:2w due:2026-10-20", 'todos_kv={"rec":"2w"}', "todos_completion_date=2026-10-25"] });
  assert.equal((await previewTodoOccurrence(f.pmRoot, { id: completion, dialect })).intended?.deadline, "2026-11-08T00:00:00.000Z");
  const leap = await f.source("leap", { deadline: "2024-02-29", field: ["todos_todotxt=x Weekly rec:+1w due:2024-02-29", 'todos_kv={"rec":"+1w"}'] });
  assert.equal((await previewTodoOccurrence(f.pmRoot, { id: leap, dialect })).intended?.deadline, "2024-03-07T00:00:00.000Z");
  let statusSeed = 0x51a7;
  for (let n = 0; n < 16; n++) {
    statusSeed = (Math.imul(statusSeed, 1664525) + 1013904223) >>> 0;
    const status = `custom-${statusSeed.toString(36)}`;
    const role = (statusSeed >>> 16) % 4;
    const roles = role % 4 === 0 ? ["terminal", "terminal_done"] : role === 1 ? ["active"] : role === 2 ? ["blocked"] : ["terminal", "terminal_canceled"];
    await f.client.schemaAddStatus(status, { role: roles });
    const row = await f.source("role-" + n, { status });
    const registry = resolveRuntimeStatusRegistry((await readSettings(f.pmRoot)).schema);
    const result = await previewTodoOccurrence(f.pmRoot, { id: row, dialect });
    assert.equal(result.ok, registry.terminal_done_statuses.has(String((await f.client.get(row)).item.status)));
    if (!result.ok) assert.equal(result.code, "not_done");
    receipt(result);
  }
});

test("every apply boundary retains source lease and handles competing target creation", async t => {
  const f = await fixture(t);
  const transitions: TodoRecurrenceTransition[] = ["before_lock", "source_locked", "before_target_read", "before_create", "after_create", "before_release"];
  for (const point of transitions) {
    const id = await f.source(point);
    const preview = await previewTodoOccurrence(f.pmRoot, { id, dialect });
    let injected = false;
    const result = await applyTodoOccurrence(f.pmRoot, { id, dialect, expectedRevision: preview.revision }, {
      author: "test-agent",
      async onTransition(step) {
        if (step !== point || injected) return;
        injected = true;
        if (point === "before_lock") await f.client.comments(id, { add: "Concurrent revision" });
        else {
          await assert.rejects(f.client.update(id, { title: "Competing change", author: "peer" }), /lock|conflict/i);
          if (point === "before_target_read" || point === "before_create") await f.client.create({ id: preview.nextId, type: "Task", title: "Foreign record", author: "peer" });
        }
      },
    });
    assert.equal(injected, true);
    if (point === "before_lock") assert.equal(result.code, "source_conflict");
    else if (point === "before_target_read" || point === "before_create") {
      assert.equal(result.code, "foreign_target");
      assert.equal((await f.client.get(preview.nextId!)).item.title, "Foreign record");
    } else assert.equal(result.action, "created");
    receipt(result);
    await f.client.update(id, { title: "Lock released", author: "peer" });
  }
  const crashId = await f.source("crash");
  const preview = await previewTodoOccurrence(f.pmRoot, { id: crashId, dialect });
  const request = { id: crashId, dialect, expectedRevision: preview.revision };
  assert.equal((await applyTodoOccurrence(f.pmRoot, request, { author: "test-agent", async onTransition(step) { if (step === "after_create") throw new Error("Injected interruption"); } })).code, "write_failed");
  assert.equal((await applyTodoOccurrence(f.pmRoot, request, { author: "test-agent" })).action, "unchanged");
  await f.client.update(preview.nextId!, { title: "Peer edited successor" });
  assert.equal((await applyTodoOccurrence(f.pmRoot, request, { author: "test-agent" })).action, "unchanged");
  assert.equal((await f.client.get(preview.nextId!)).item.title, "Peer edited successor");
});

test("packed CLI works without git or pm on PATH; compact JSON/TOON and concurrent processes", async t => {
  const f = await fixture(t);
  const id = await f.source("cli");
  const args = ["todos", "recur", "preview", id, "--dialect", dialect];
  const preview = JSON.parse(f.command([...args, "--json"], true)) as TodoRecurrenceResult;
  assert.equal(preview.action, "preview");
  const toon = decodeToon(f.command(args, true)) as unknown as TodoRecurrenceResult;
  assert.deepEqual(toon, preview);
  const apply = ["todos", "recur", "apply", id, "--dialect", dialect, "--expected-revision", preview.revision!];
  /** Competing independent host processes must never duplicate or overwrite. */
  const child = (): Promise<{ code: number | null; result: TodoRecurrenceResult }> => new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, [f.cli, "--pm-path", f.pmRoot, ...apply, "--json"], { cwd: f.root, env: { ...f.env, PATH: join(f.root, "bin") } });
    let stdout = "";
    process_.stdout.on("data", chunk => { stdout += String(chunk); });
    process_.on("error", reject);
    process_.on("close", code => { try { resolve({ code, result: JSON.parse(stdout) as TodoRecurrenceResult }); } catch (error) { reject(error); } });
  });
  const results = await Promise.all([child(), child()]);
  assert.equal(results.filter(row => row.result.action === "created").length, 1);
  assert.ok(results.every(row => row.result.action === "created" || row.result.action === "unchanged" || row.result.code === "write_failed"));
  assert.equal(JSON.parse(f.command([...apply, "--json"], true)).action, "unchanged");
  assert.equal((await f.client.listAllComplete()).items.length, 2);
  const disabled = JSON.parse(f.command(["todos", "recur", "apply", id, "--json"], true));
  assert.equal(disabled.action, "disabled");
  const priorExit = process.exitCode;
  const commandResult = await f.harness.runCommand({ command: "todos recur", args: ["preview", id], options: { dialect }, pmRoot: f.pmRoot });
  assert.equal((commandResult.result as TodoRecurrenceResult).action, "unchanged");
  const applyResult = await f.harness.runCommand({ command: "todos recur", args: ["apply", id], options: { dialect, expectedRevision: preview.revision }, pmRoot: f.pmRoot });
  assert.equal((applyResult.result as TodoRecurrenceResult).action, "unchanged");
  const bad = await f.harness.runCommand({ command: "todos recur", args: ["preview", id], options: { dialect, timezone: "UTC" }, pmRoot: f.pmRoot });
  assert.equal((bad.result as TodoRecurrenceResult).code, "unsupported_timezone");
  process.exitCode = priorExit;
  await assert.rejects(f.harness.runCommand({ command: "todos recur", args: ["unknown", id], pmRoot: f.pmRoot }), /preview\|apply/);
});

/** A deterministic semantic source, independent of package parsers and serializers. */
interface ModelInput { priority: number; due: string; owner: string; description: string; sprint: string }
/** Compare persisted SDK state with a separate SDK-normalized native reference tracker. */
test("seed 0x72656375: 500 random import/export/sync sequences retain fields and relationships", { timeout: 600000 }, async t => {
  const f = await fixture(t);
  const originalError = console.error;
  // Import/sync progress contains disposable filenames; keep tracked receipts public-safe.
  t.mock.method(console, "error", (...values: unknown[]) => {
    if (typeof values[0] === "string" && /^(Imported |sync: )/.test(values[0])) return;
    originalError(...values);
  });
  const { referenceRoot, reference } = await referenceFixture(f);
  for (const client of [f.client, reference]) {
    await client.create({ id: "anchor", type: "Task", title: "Relationship anchor" });
    await client.create({ id: "model", type: "Task", title: "Model weekly", status: "closed", closeReason: "Model completed", parent: "fixture-anchor", dep: ["id=fixture-anchor,kind=related_to"], description: "Retained model description", body: "Retained body\n\nwith  whitespace", assignee: "test-agent", sprint: "initial", priority: 1, deadline: "2026-10-20", tags: "project,context", field: ['todos_kv={"rec":"+1w","owner":"initial"}', "todos_creation_date=2026-10-01", "todos_completion_date=2026-10-25", "todos_source_created_at=2026-10-01T00:00:00.000Z", "todos_source_updated_at=2026-10-25T00:00:00.000Z", "todos_todotxt=x 2026-10-25 (B) 2026-10-01 Model weekly +project @context rec:+1w due:2026-10-20 owner:initial"] });
  }
  const initial = await previewTodoOccurrence(f.pmRoot, { id: "fixture-model", dialect });
  assert.equal((await applyTodoOccurrence(f.pmRoot, { id: "fixture-model", dialect, expectedRevision: initial.revision }, { author: "test-agent" })).action, "created");
  await f.client.update(initial.nextId!, { title: "Retained successor" });
  const keys = ["id", "title", "description", "body", "type", "status", "priority", "tags", "deadline", "assignee", "sprint", "parent", "dependencies", "todos_kv", "todos_todotxt", "todos_creation_date", "todos_completion_date", "todos_source_created_at", "todos_source_updated_at"];
  // Relationship timestamps are SDK-owned; each oracle uses its own real timestamps.
  const snapshotSettings = await readSettings(f.pmRoot);
  /** Read the entire persisted native document through the SDK without derived UI facets. */
  const snapshot = async (pmRoot: string): Promise<Record<string, unknown>> => {
    const located = await locateItem(pmRoot, "fixture-model");
    assert.ok(located);
    const { document } = await readLocatedItem(located, { schema: snapshotSettings.schema, extensionFieldNames: ["todos_kv", "todos_todotxt", "todos_creation_date", "todos_completion_date", "todos_source_created_at", "todos_source_updated_at"] });
    return { ...document.metadata, body: document.body };
  };
  const relationBefore = (await snapshot(f.pmRoot)).dependencies;
  const referenceRelationBefore = (await snapshot(referenceRoot)).dependencies;
  let actualClient = f.client;
  let referenceClient = reference;
  let activeRoot = f.pmRoot;
  let oracleRoot = referenceRoot;
  /** Read both stores afresh and compare all native fields the package can update. */
  const check = async (label: string) => {
    const actual = await snapshot(activeRoot);
    const expected = await snapshot(oracleRoot);
    assert.deepEqual(actual.dependencies, relationBefore, label + " actual relationships");
    assert.deepEqual(expected.dependencies, referenceRelationBefore, label + " reference relationships");
    for (const key of keys.filter(key => key !== "dependencies")) assert.deepEqual(actual[key], expected[key], label + " " + key);
  };
  let seed = 0x72656375;
  /** Reproducible pseudo-random selection; seed appears in every failure context. */
  const random = (max: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const inputs: ModelInput[] = [];
  const file = join(f.root, "model-input.txt");
  const counts = { sequences: 0, imports: 0, exports: 0, syncs: 0, olderReplays: 0, crlf: 0 };
  const formats = ["jsonl", "todotxt", "markdown", "checkbox", "todojson"] as const;
  for (let sequence = 0; sequence < 500; sequence++) {
    const tracker = join(f.root, "sequence-current");
    const oracle = join(f.root, "oracle-current");
    cpSync(f.pmRoot, tracker, { recursive: true });
    cpSync(referenceRoot, oracle, { recursive: true });
    activeRoot = tracker;
    oracleRoot = oracle;
    actualClient = new PmClient({ pmRoot: tracker, cwd: f.root, author: "test-agent" });
    referenceClient = new PmClient({ pmRoot: oracle, cwd: f.root, author: "test-agent" });
    const current: ModelInput = { priority: random(5), due: `2026-11-${String(1 + random(28)).padStart(2, "0")}`, owner: `owner${random(10000)}`, description: `Description ${random(10000)}\nwith  spaces`, sprint: `cycle-${random(10)}` };
    inputs.push(current);
    const length = 2 + random(2);
    for (let operation = 0; operation < length; operation++) {
      const replay = random(inputs.length);
      const model = operation === 0 ? current : inputs[replay];
      if (model !== current) counts.olderReplays++;
      const format = formats[random(formats.length)];
      const crlf = random(2) === 0;
      if (crlf) counts.crlf++;
      const line = `x 2026-10-25 (${String.fromCharCode(65 + model.priority)}) 2026-10-01 Model weekly +project @context rec:+1w due:${model.due} owner:${model.owner}`;
      const expected: PmUpdateActionOptions = { title: "Model weekly" };
      let content: string;
      if (format === "jsonl") {
        content = JSON.stringify({ id: "fixture-model", title: "Model weekly", status: "closed", type: "Task", priority: model.priority, tags: ["project", "context"], deadline: model.due, description: model.description, assignee: "test-agent", sprint: model.sprint, kv: { rec: "+1w", owner: model.owner }, todos_todotxt: line, creationDate: "2026-10-01", completionDate: "2026-10-25", created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-25T00:00:00.000Z" });
        Object.assign(expected, { type: "Task", priority: model.priority, tags: "project,context", deadline: model.due, description: model.description, assignee: "test-agent", sprint: model.sprint, field: [`todos_kv=${JSON.stringify({ rec: "+1w", owner: model.owner })}`, "todos_todotxt=" + line, "todos_creation_date=2026-10-01", "todos_completion_date=2026-10-25", "todos_source_created_at=2026-10-01T00:00:00.000Z", "todos_source_updated_at=2026-10-25T00:00:00.000Z"] });
      } else if (format === "todotxt") {
        content = line;
        Object.assign(expected, { priority: model.priority, tags: "project,context", deadline: model.due, field: [`todos_kv=${JSON.stringify({ rec: "+1w", owner: model.owner })}`, "todos_todotxt=" + line, "todos_creation_date=2026-10-01", "todos_completion_date=2026-10-25"] });
      } else if (format === "todojson") {
        content = JSON.stringify({ action: "list", todos: [{ id: 1, text: "Model weekly", done: true }], nextId: 2 });
        expected.tags = "todo";
      } else {
        content = `- [x] Model weekly (p${model.priority}) due:${model.due} <!-- fixture-model -->`;
        Object.assign(expected, { priority: model.priority, deadline: model.due });
      }
      writeFileSync(file, (crlf ? " \t\r\n" : "\n") + content + (crlf ? "\r\n\r\n" : "\n\n"));
      const options = { format, upsert: true, "todotxt-mapping": "fidelity", "section-tags": false };
      await referenceClient.update("fixture-model", expected);
      if (random(3) === 0) {
        const result = await f.harness.runCommand({ command: "todos sync", args: [file], options, pmRoot: activeRoot });
        assert.equal((result.result as { updated: number }).updated, 1); counts.syncs++;
      } else {
        const result = await f.harness.runImporter({ importer: random(2) ? "todos" : "todos-import", args: [file], options, pmRoot: activeRoot });
        assert.equal((result.result as { updated: number }).updated, 1); counts.imports++;
      }
      await check(`seed 0x72656375 sequence ${sequence} op ${operation} ${format}`);
      const exported = await f.harness.runExporter({ exporter: "todos", options: { format: sequence % 7 === 6 ? "tasklist" : format, "todotxt-mapping": "fidelity", metadata: true }, pmRoot: activeRoot });
      assert.equal((exported.result as { exported: number }).exported, 3); counts.exports++;
      const output = (exported.result as { markdown: string }).markdown;
      const outputFormat = sequence % 7 === 6 ? "tasklist" : format;
      if (outputFormat === "jsonl") {
        const rows = output.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
        const next = rows.find(row => row.id === initial.nextId)!;
        assert.equal((next.kv as Record<string, string>).pmoccurrence, initial.occurrence);
      }
      if (outputFormat === "todotxt") {
        const sourceLine = output.split("\n").find(line => line.includes("Model weekly"))!;
        await referenceClient.update("fixture-model", { field: ["todos_todotxt=" + sourceLine] });
        assert.ok(output.includes("pmoccurrence:" + initial.occurrence));
      }
      if (outputFormat === "todojson") await referenceClient.update("fixture-model", { tags: "todo" });
      writeFileSync(file, output);
      const roundTrip = await f.harness.runImporter({ importer: "todos", args: [file], options: { ...options, format: outputFormat === "tasklist" ? "markdown" : outputFormat }, pmRoot: activeRoot });
      assert.equal((roundTrip.result as { updated: number }).updated, 3);
      await check(`export roundtrip sequence ${sequence} op ${operation} ${outputFormat}`);
      // Disabled recurrence is a no-op even after old-input replays and lossy projections.
      assert.equal((await applyTodoOccurrence(activeRoot, { id: "fixture-model" }, { author: "test-agent" })).action, "disabled");
      await check(`disabled sequence ${sequence} op ${operation}`);
    }
    const preview = await previewTodoOccurrence(activeRoot, { id: "fixture-model", dialect });
    if (preview.ok) {
      const retry = await applyTodoOccurrence(activeRoot, { id: "fixture-model", dialect, expectedRevision: preview.revision, expectedTargetRevision: preview.targetRevision }, { author: "test-agent" });
      assert.equal(retry.action, preview.action === "reschedule" ? "rescheduled" : "unchanged");
    } else assert.ok(["invalid_source", "foreign_target"].includes(preview.code!));
    assert.equal((await actualClient.listAllComplete()).items.length, 3, "At most one successor after random replays");
    rmSync(tracker, { recursive: true, force: true });
    rmSync(oracle, { recursive: true, force: true });
    counts.sequences++;
    if (sequence % 100 === 99) t.diagnostic(JSON.stringify(counts));
  }
  assert.equal(counts.sequences, 500);
  assert.ok(counts.olderReplays > 500 && counts.syncs > 300 && counts.crlf > 500);
  t.diagnostic(JSON.stringify(counts));
});

test("bounded source metadata, foreign provenance and invalid history receive typed refusals", async t => {
  const f = await fixture(t);
  const invalidObjects = [new Date(), Object.create({ id: "inherited" }), Object.defineProperty({}, "id", { get() { throw new Error("accessor"); } }), new Proxy({}, { getPrototypeOf() { throw new Error("proxy"); } })];
  for (const value of invalidObjects) assert.equal((await previewTodoOccurrence(f.pmRoot, value)).code, "invalid_input");
  const sources: Array<{ name: string; fields: string[]; code: string; title?: string }> = [
    { name: "missing", fields: [], code: "invalid_source" },
    { name: "empty", fields: ["todos_todotxt= ", 'todos_kv={"rec":"+1w"}'], code: "invalid_source" },
    { name: "mismatch", fields: ["todos_todotxt=x Weekly rec:+2w due:2026-10-20", 'todos_kv={"rec":"+1w"}'], code: "invalid_source" },
    { name: "duplicate-due", fields: ["todos_todotxt=x Weekly rec:+1w due:2026-10-19 due:2026-10-20", 'todos_kv={"rec":"+1w"}'], code: "invalid_source" },
    { name: "oversized", fields: ["todos_todotxt=" + "x".repeat(16385), 'todos_kv={"rec":"+1w"}'], code: "invalid_source" },
    { name: "multiline", fields: ["todos_todotxt=x Weekly\nrec:+1w due:2026-10-20", 'todos_kv={"rec":"+1w"}'], code: "invalid_source" },
    { name: "bad-token", fields: ["todos_todotxt=x Weekly rec:+1w due:2026-10-20", 'todos_kv={"rec":"+1w","foreign":"has spaces"}'], code: "invalid_source" },
    { name: "long-kv", fields: ["todos_todotxt=x Weekly rec:+1w due:2026-10-20", "todos_kv=" + JSON.stringify({ rec: "+1w", foreign: "a".repeat(1001) })], code: "invalid_source" },
    { name: "many-kv", fields: ["todos_todotxt=x Weekly rec:+1w due:2026-10-20", "todos_kv=" + JSON.stringify({ rec: "+1w", ...Object.fromEntries(Array.from({ length: 100 }, (_, n) => ["key" + n, "value"])) })], code: "invalid_source" },
    { name: "reserved", fields: ["todos_todotxt=x Weekly rec:+1w due:2026-10-20", 'todos_kv={"rec":"+1w","pmseries":"foreign"}'], code: "foreign_target" },
    { name: "forged", fields: ["todos_todotxt=x Weekly rec:+1w due:2026-10-20", "todos_kv=" + JSON.stringify({ rec: "+1w", pmseries: "a".repeat(64), pmoccurrence: "b".repeat(64), pmrevision: "c".repeat(64), pmoriginaldue: "2026-10-20", pmprevious: "fixture-external" })], code: "foreign_target" },
    { name: "title", fields: ["todos_todotxt=x Weekly rec:+1w due:2026-10-20", 'todos_kv={"rec":"+1w"}'], title: "Weekly due:2026-10-20", code: "invalid_source" },
  ];
  for (const source of sources) {
    const id = await f.source("invalid-" + source.name, { field: source.fields, ...(source.title ? { title: source.title } : {}) });
    const before = (await f.client.get(id)).item;
    const preview = await previewTodoOccurrence(f.pmRoot, { id, dialect });
    assert.equal(preview.code, source.code, source.name); receipt(preview);
    assert.deepEqual((await f.client.get(id)).item, before);
  }
  const id = await f.source("damaged");
  const path = join(f.pmRoot, "history", id + ".jsonl");
  writeFileSync(path, "{invalid\n");
  const result = await previewTodoOccurrence(f.pmRoot, { id, dialect });
  assert.equal(result.ok, false); receipt(result);
  const legacy = await f.source("legacy");
  const legacyPath = join(f.pmRoot, "history", legacy + ".jsonl");
  const entries = readFileSync(legacyPath, "utf8").trim().split("\n").map(line => {
    const entry = JSON.parse(line) as Record<string, unknown>;
    delete entry.record_hash; delete entry.record_hash_version;
    return entry;
  });
  // Disposable synthetic history fixture: model a valid pre-record-hash stream.
  writeFileSync(legacyPath, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const preview = await previewTodoOccurrence(f.pmRoot, { id: legacy, dialect });
  assert.equal(preview.action, "preview");
  assert.match(preview.revision!, /^[a-f0-9]{64}$/);
  assert.equal((await applyTodoOccurrence(f.pmRoot, { id: legacy, dialect, expectedRevision: preview.revision }, { author: "test-agent" })).action, "created");
});

test("replayed imports cannot multiply a completed successor after series metadata changes", async t => {
  const f = await fixture(t);
  const root = await f.source("replayed-series");
  const first = await previewTodoOccurrence(f.pmRoot, { id: root, dialect });
  assert.equal((await applyTodoOccurrence(f.pmRoot, { id: root, dialect, expectedRevision: first.revision }, { author: "test-agent" })).action, "created");
  const id = first.nextId!;
  await f.client.close(id, "Completed recurring successor");
  const original = await previewTodoOccurrence(f.pmRoot, { id, dialect });
  assert.equal((await applyTodoOccurrence(f.pmRoot, { id, dialect, expectedRevision: original.revision }, { author: "test-agent" })).action, "created");
  const input = join(f.root, "old-source.jsonl");
  const item = (await f.client.get(id)).item;
  const old = { id, title: item.title, status: item.status, type: item.type, priority: item.priority, tags: item.tags, deadline: item.deadline, todos_todotxt: `Weekly rec:+1w due:${String(item.deadline).slice(0, 10)}`, kv: { rec: "+1w" } };
  for (const importer of ["todos", "todos-import"]) {
    writeFileSync(input, JSON.stringify(old) + "\r\n");
    await f.harness.runImporter({ importer, args: [input], options: { format: "jsonl", upsert: true }, pmRoot: f.pmRoot });
    const preview = await previewTodoOccurrence(f.pmRoot, { id, dialect });
    assert.equal(preview.code, "foreign_target");
    assert.equal((await f.client.listAllComplete()).items.length, 3);
    assert.equal((await f.client.get(original.nextId!)).item.id, original.nextId);
  }
});

test("stored schedule receipts expose source-rule reschedule and preserve manual due edits", async t => {
  const f = await fixture(t);
  const id = await f.source("review");
  const initial = await previewTodoOccurrence(f.pmRoot, { id, dialect });
  const created = await applyTodoOccurrence(f.pmRoot, { id, dialect, expectedRevision: initial.revision }, { author: "test-agent" });
  assert.equal(created.nextDue, "2026-10-27");
  assert.equal(created.status, "open");
  assert.equal(created.stored?.deadline, (await f.client.get(created.nextId!)).item.deadline);
  await f.client.update(id, { field: ['todos_kv={"rec":"+2w"}', "todos_todotxt=x Weekly rec:+2w due:2026-10-20"] });
  const preview = await previewTodoOccurrence(f.pmRoot, { id, dialect });
  assert.equal(preview.action, "reschedule");
  assert.equal(preview.nextDue, "2026-10-27");
  assert.equal(preview.stored?.deadline, "2026-10-27T00:00:00.000Z");
  assert.equal(preview.intended?.deadline, "2026-11-03T00:00:00.000Z");
  const request = { id, dialect, expectedRevision: preview.revision, expectedTargetRevision: preview.targetRevision };
  const updated = await applyTodoOccurrence(f.pmRoot, request, { author: "test-agent" });
  assert.equal(updated.action, "rescheduled");
  assert.equal(updated.updated, 1);
  assert.equal(updated.nextDue, "2026-11-03");
  assert.equal(updated.stored?.deadline, (await f.client.get(updated.nextId!)).item.deadline);
  assert.notEqual(updated.targetRevision, preview.targetRevision);
  assert.equal((await previewTodoOccurrence(f.pmRoot, { id, dialect })).action, "unchanged");
  assert.equal((await applyTodoOccurrence(f.pmRoot, request, { author: "test-agent" })).code, "target_conflict");
  await f.client.update(created.nextId!, { deadline: "2026-11-05", author: "peer" });
  const manual = await previewTodoOccurrence(f.pmRoot, { id, dialect });
  assert.equal(manual.code, "foreign_schedule");
  assert.equal(manual.nextDue, "2026-11-05");
  assert.equal(manual.stored?.deadline, "2026-11-05T00:00:00.000Z");
  assert.equal(manual.intended?.deadline, "2026-11-03T00:00:00.000Z");
  const refused = await applyTodoOccurrence(f.pmRoot, { id, dialect, expectedRevision: manual.revision, expectedTargetRevision: manual.targetRevision }, { author: "test-agent" });
  assert.equal(refused.code, "foreign_schedule");
  assert.equal((await f.client.get(created.nextId!)).item.deadline, "2026-11-05T00:00:00.000Z");
});

/** Independent state for one source and its fixed successor identity. */
interface ScheduleModel {
  source: { exists: boolean; rule: string; due: string; completion: string; status: string };
  target: { exists: boolean; deleted: boolean; schedule: TodoOccurrenceSchedule; managed: TodoOccurrenceSchedule };
}
/** Independent reference calendar: native SDK normalization, semantic source fields only. */
function modelIntent(model: ScheduleModel): TodoOccurrenceSchedule | undefined {
  const rule = /^(\+?)([1-4])w$/.exec(model.source.rule);
  if (!rule || model.source.status !== "closed") return undefined;
  const anchor = rule[1] ? model.source.due : model.source.completion;
  const base = new Date(anchor + "T00:00:00.000Z");
  const next = new Date(base.getTime() + Number(rule[2]) * 7 * 86400000);
  return { deadline: resolveIsoOrRelative(next.toISOString(), base, "deadline"), rule: model.source.rule, originalDue: model.source.due, anchor, status: "open" };
}
/** Compare contracts structurally; no package parser or formatter participates in the oracle. */
function modelSame(a: TodoOccurrenceSchedule, b: TodoOccurrenceSchedule): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

test("stored schedule model: 500 random source/successor edit, lifecycle, deletion and replay sequences", { timeout: 1200000 }, async t => {
  const f = await fixture(t);
  const sourceId = await f.source("schedule-model");
  const first = await previewTodoOccurrence(f.pmRoot, { id: sourceId, dialect });
  assert.equal((await applyTodoOccurrence(f.pmRoot, { id: sourceId, dialect, expectedRevision: first.revision }, { author: "test-agent" })).action, "created");
  const targetId = first.nextId!;
  const settings = await readSettings(f.pmRoot);
  const initial: TodoOccurrenceSchedule = { deadline: "2026-10-27T00:00:00.000Z", rule: "+1w", originalDue: "2026-10-20", anchor: "2026-10-20", status: "open" };
  const totals: Record<string, number> = { sequences: 0, steps: 0, rescheduled: 0, unchanged: 0, manualPreserved: 0, replays: 0 };
  for (const initialSeed of [0x51ceda7a, 0x20261026]) {
    let seed = initialSeed;
    /** Select operations using high bits so consecutive branch choices remain varied. */
    const random = (max: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * max); };
    for (let sequence = 0; sequence < 250; sequence++) {
      const root = join(f.root, "schedule-current");
      cpSync(f.pmRoot, root, { recursive: true });
      const client = new PmClient({ pmRoot: root, cwd: f.root, author: "test-agent" });
      const model: ScheduleModel = { source: { exists: true, rule: "+1w", due: "2026-10-20", completion: "2026-10-25", status: "closed" }, target: { exists: true, deleted: false, schedule: { ...initial }, managed: { ...initial } } };
      const plans: TodoRecurrenceRequest[] = [];
      /** Read complete native metadata through the SDK, without derived list projections. */
      const readState = async (id: string) => {
        const located = await locateItem(root, id);
        if (!located) return undefined;
        return (await readLocatedItem(located, { schema: settings.schema, extensionFieldNames: ["todos_kv", "todos_todotxt", "todos_completion_date"] })).document;
      };
      /** Native revisions are oracle inputs, independent of the package's receipts. */
      const tip = async (id: string): Promise<string | undefined> => (await readHistoryEntries(getHistoryPath(root, id), id)).at(-1)?.record_hash;
      /** Read the source/target model back after every operation, including refused applies. */
      const check = async (label: string, result?: TodoRecurrenceResult) => {
        const source = await readState(sourceId), target = await readState(targetId);
        assert.equal(Boolean(source), model.source.exists, label + " source existence");
        assert.equal(Boolean(target), model.target.exists, label + " target existence");
        if (source) {
          assert.equal(source.metadata.status, model.source.status, label + " source status");
          assert.equal(source.metadata.deadline, resolveIsoOrRelative(model.source.due, new Date("2026-10-20T00:00:00.000Z"), "deadline"), label + " source due");
          assert.equal((source.metadata.todos_kv as Record<string, string>).rec, model.source.rule, label + " source rule");
          assert.equal(source.metadata.todos_completion_date, model.source.completion, label + " source completion");
          const sourceTokens = String(source.metadata.todos_todotxt).split(/\s+/);
          assert.ok(sourceTokens.includes("due:" + model.source.due), label + " retained source due token");
          assert.ok(sourceTokens.includes("rec:" + model.source.rule), label + " retained source rule token");
        }
        if (target) {
          const kv = target.metadata.todos_kv as Record<string, string>;
          const stored: TodoOccurrenceSchedule = { deadline: target.metadata.deadline ?? null, rule: kv.rec, originalDue: kv.pmoriginaldue, anchor: kv.pmanchor, status: target.metadata.status };
          assert.deepEqual(stored, model.target.schedule, label + " native target schedule");
          const targetTokens = String(target.metadata.todos_todotxt).split(/\s+/);
          assert.equal(targetTokens.filter(token => token.startsWith("due:")).length, 1, label + " unambiguous target due token");
          assert.equal(targetTokens.filter(token => token.startsWith("rec:")).length, 1, label + " unambiguous target rule token");
          assert.ok(targetTokens.includes("due:" + model.target.managed.deadline!.slice(0, 10)), label + " target source due reflects last package write");
          assert.ok(targetTokens.includes("rec:" + model.target.managed.rule), label + " target source rule reflects last package write");
          if (result?.stored) {
            assert.deepEqual(result.stored, model.target.schedule, label + " receipt equals model and SDK");
            assert.deepEqual(result.intended, modelIntent(model), label + " intent equals reference source rule");
            assert.equal(result.targetExists, true, label + " existence reads stored");
            assert.equal(result.revision, await tip(sourceId), label + " source revision reads stored");
            assert.equal(result.nextDue, model.target.schedule.deadline!.slice(0, 10), label + " top-level due reads stored");
            assert.equal(result.status, target.metadata.status, label + " top-level status reads stored");
            assert.equal(result.nextId, target.metadata.id, label + " identity reads stored");
            assert.equal(result.series, kv.pmseries, label + " series reads stored");
            assert.equal(result.occurrence, kv.pmoccurrence, label + " occurrence reads stored");
            assert.equal(result.originalDue, kv.pmoriginaldue, label + " original due reads stored");
            assert.equal(result.anchor, kv.pmanchor, label + " anchor reads stored");
            assert.equal(result.targetRevision, await tip(targetId), label + " target revision reads stored");
          } else if (result) assert.equal(result.nextDue, undefined, label + " refusal cannot echo computed schedule");
        } else if (result) assert.equal(result.nextDue, undefined, label + " missing target has no stored due");
        if (result) receipt(result);
      };
      /** Predict outcomes from the reference state and captured native revision coordinates. */
      const operation = async (kind: "preview" | "apply" | "replay", label: string) => {
        const intended = modelIntent(model);
        const sourceTip = model.source.exists ? await tip(sourceId) : undefined;
        const targetTip = model.target.exists ? await tip(targetId) : undefined;
        const fresh: TodoRecurrenceRequest = { id: sourceId, dialect, expectedRevision: sourceTip ?? "0".repeat(64), expectedTargetRevision: targetTip };
        const input = kind === "replay" && plans.length ? plans[random(plans.length)] : fresh;
        const applying = kind !== "preview";
        let expected: string;
        if (!model.source.exists) expected = "missing_item";
        else if (applying && input.expectedRevision !== sourceTip) expected = "source_conflict";
        else if (model.source.status !== "closed") expected = "not_done";
        else if (!intended) expected = "unsupported_recurrence";
        else if (!model.target.exists) expected = "target_deleted";
        else if (!modelSame(model.target.schedule, model.target.managed)) expected = "foreign_schedule";
        else if (applying && input.expectedTargetRevision && input.expectedTargetRevision !== targetTip) expected = "target_conflict";
        else if (modelSame(model.target.schedule, intended)) expected = "unchanged";
        else if (!applying) expected = "reschedule";
        else if (!input.expectedTargetRevision) expected = "target_conflict";
        else expected = "rescheduled";
        const before = { ...model.target.schedule };
        const equalBefore = intended && modelSame(before, intended);
        const result = applying ? await applyTodoOccurrence(root, input, { author: "test-agent" }) : await previewTodoOccurrence(root, { id: sourceId, dialect });
        assert.equal(result.code ?? result.action, expected, label + " outcome");
        if (result.ok && model.target.exists && expected !== "rescheduled") assert.equal(result.action === "unchanged", equalBefore, label + " unchanged iff stored equals intended");
        if (expected === "rescheduled") {
          model.target.schedule = { ...intended! }; model.target.managed = { ...intended! }; totals.rescheduled++;
        }
        if (expected === "unchanged") totals.unchanged++;
        if (expected === "foreign_schedule") {
          assert.deepEqual(model.target.schedule, before, label + " hand edit retained"); totals.manualPreserved++;
        }
        if (kind === "preview") plans.push(fresh);
        if (kind === "replay") totals.replays++;
        await check(label, result);
      };
      /** Native source edits keep syntax and scheduling facts coherent, with no package normalizer. */
      const editSource = async () => {
        await client.update(sourceId, { deadline: model.source.due, field: ["todos_kv=" + JSON.stringify({ rec: model.source.rule }), `todos_todotxt=x Weekly rec:${model.source.rule} due:${model.source.due}`, "todos_completion_date=" + model.source.completion] });
      };
      // Every sequence begins with the exact review class: owned schedule differs from intent.
      model.source.rule = "+2w";
      await editSource();
      await check("bootstrap source edit"); totals.steps++;
      await operation("preview", `seed ${initialSeed} sequence ${sequence} bootstrap preview`); totals.steps++;
      await operation("apply", `seed ${initialSeed} sequence ${sequence} bootstrap apply`); totals.steps++;
      const count = 8 + random(5);
      for (let step = 0; step < count; step++) {
        const choice = random(13);
        const label = `seed ${initialSeed} sequence ${sequence} step ${step} choice ${choice}`;
        totals["op" + choice] = (totals["op" + choice] ?? 0) + 1;
        if (choice <= 2 && model.source.exists) {
          if (choice === 0) model.source.rule = (random(2) ? "+" : "") + (1 + random(4)) + "w";
          if (choice === 1) model.source.rule = (random(2) ? "+" : "") + (1 + random(4)) + ["w", "d", "m"][random(3)];
          if (choice === 2) model.source.due = ["2026-10-20", "2026-10-21", "2026-10-25"][random(3)];
          await editSource();
        } else if (choice === 3 && model.source.exists) {
          if (model.source.status !== "closed") await client.close(sourceId, "Model source completion");
          model.source.status = "closed"; model.source.completion = ["2026-10-25", "2026-10-26", "2026-10-28"][random(3)];
          await editSource();
        } else if (choice === 4 && model.source.exists && model.source.status === "closed") {
          await client.reopen(sourceId, "Model source reopening"); model.source.status = "open";
        } else if (choice === 5 && model.source.exists) {
          await client.delete(sourceId); model.source.exists = false;
        } else if (choice === 6 && model.target.exists) {
          const deadline = ["2026-11-09", "2026-11-10", "2026-12-01"][random(3)];
          await client.update(targetId, { deadline, author: "peer" });
          model.target.schedule.deadline = resolveIsoOrRelative(deadline, new Date("2026-10-20T00:00:00.000Z"), "deadline");
        } else if (choice === 7 && model.target.exists && model.target.schedule.status !== "closed") {
          await client.close(targetId, "Peer successor completion"); model.target.schedule.status = "closed";
        } else if (choice === 8 && model.target.exists) {
          await client.delete(targetId); model.target.exists = false; model.target.deleted = true;
        } else if (choice === 9 && model.target.exists) {
          if (model.target.schedule.status === "closed") await client.reopen(targetId, "Peer successor reopening");
          const status = random(2) ? "open" : "in_progress";
          await client.update(targetId, { status }); model.target.schedule.status = status;
        } else if (choice >= 10) await operation(choice === 10 ? "preview" : choice === 11 ? "apply" : "replay", label);
        await check(label); totals.steps++;
      }
      // Every final state is observed, even when the final random operation was an edit/delete.
      await operation("preview", `seed ${initialSeed} sequence ${sequence} final preview`); totals.steps++;
      await operation("apply", `seed ${initialSeed} sequence ${sequence} final apply`); totals.steps++;
      rmSync(root, { recursive: true, force: true });
      totals.sequences++;
    }
    t.diagnostic(JSON.stringify({ seed: initialSeed, ...totals }));
  }
  assert.equal(totals.sequences, 500);
  assert.ok(totals.rescheduled >= 500 && totals.manualPreserved > 0 && totals.replays > 100);
  for (let choice = 0; choice < 13; choice++) assert.ok(totals["op" + choice] > 100, "operation class " + choice);
});

test("stored schedule CAS and read-back revalidate every reschedule boundary", async t => {
  const f = await fixture(t);
  const points: TodoRecurrenceTransition[] = ["before_lock", "source_locked", "before_target_read", "before_reschedule", "target_locked", "after_reschedule", "before_release"];
  for (const point of points) {
    const id = await f.source("cas-" + point);
    const initial = await previewTodoOccurrence(f.pmRoot, { id, dialect });
    await applyTodoOccurrence(f.pmRoot, { id, dialect, expectedRevision: initial.revision }, { author: "test-agent" });
    await f.client.update(id, { field: ['todos_kv={"rec":"+2w"}', "todos_todotxt=x Weekly rec:+2w due:2026-10-20"] });
    const plan = await previewTodoOccurrence(f.pmRoot, { id, dialect });
    assert.equal(plan.action, "reschedule");
    let injected = false;
    const result = await applyTodoOccurrence(f.pmRoot, { id, dialect, expectedRevision: plan.revision, expectedTargetRevision: plan.targetRevision }, {
      author: "test-agent",
      async onTransition(step) {
        if (step !== point || injected) return;
        injected = true;
        if (step === "before_lock") await f.client.comments(id, { add: "Peer source revision" });
        else if (step === "target_locked") {
          await assert.rejects(f.client.update(initial.nextId!, { deadline: "2026-12-01", author: "peer" }), /lock|conflict/i);
          await assert.rejects(f.client.update(id, { title: "Peer source", author: "peer" }), /lock|conflict/i);
        } else await f.client.update(initial.nextId!, { deadline: "2026-12-01", author: "peer" });
      },
    });
    assert.equal(injected, true, point);
    if (point === "before_lock") assert.equal(result.code, "source_conflict");
    else if (point === "target_locked") {
      assert.equal(result.action, "rescheduled");
      assert.equal(result.nextDue, "2026-11-03");
    } else {
      assert.equal(result.code, "foreign_schedule", point);
      assert.equal(result.nextDue, "2026-12-01", point);
      assert.equal(result.stored?.deadline, (await f.client.get(initial.nextId!)).item.deadline, point);
      assert.equal(result.updated, point === "after_reschedule" || point === "before_release" ? 1 : 0);
    }
    // Both leases have been released, and no peer-owned value was deleted.
    await f.client.comments(id, { add: "Source lease released", author: "peer" });
    await f.client.comments(initial.nextId!, { add: "Target lease released", author: "peer" });
  }
  const id = await f.source("cas-comment");
  const first = await previewTodoOccurrence(f.pmRoot, { id, dialect });
  await applyTodoOccurrence(f.pmRoot, { id, dialect, expectedRevision: first.revision }, { author: "test-agent" });
  await f.client.update(id, { field: ['todos_kv={"rec":"+2w"}', "todos_todotxt=x Weekly rec:+2w due:2026-10-20"] });
  const plan = await previewTodoOccurrence(f.pmRoot, { id, dialect });
  const conflict = await applyTodoOccurrence(f.pmRoot, { id, dialect, expectedRevision: plan.revision, expectedTargetRevision: plan.targetRevision }, {
    author: "test-agent", async onTransition(step) { if (step === "before_reschedule") await f.client.comments(first.nextId!, { add: "Concurrent target revision" }); },
  });
  assert.equal(conflict.code, "target_conflict");
  assert.equal(conflict.nextDue, "2026-10-27");
  assert.equal((await f.client.get(first.nextId!)).item.deadline, "2026-10-27T00:00:00.000Z");
  const fresh = await previewTodoOccurrence(f.pmRoot, { id, dialect });
  const missingCas = await applyTodoOccurrence(f.pmRoot, { id, dialect, expectedRevision: fresh.revision }, { author: "test-agent" });
  assert.equal(missingCas.code, "target_conflict");
  assert.equal(missingCas.nextDue, "2026-10-27");
  const cliPlan = JSON.parse(f.command(["todos", "recur", "preview", id, "--dialect", dialect, "--json"], true)) as TodoRecurrenceResult;
  const cliApplied = JSON.parse(f.command(["todos", "recur", "apply", id, "--dialect", dialect, "--expected-revision", cliPlan.revision!, "--expected-target-revision", cliPlan.targetRevision!, "--json"], true)) as TodoRecurrenceResult;
  assert.equal(cliApplied.action, "rescheduled");
  assert.equal(cliApplied.nextDue, "2026-11-03");
  const unchanged = await previewTodoOccurrence(f.pmRoot, { id, dialect });
  const peerAfterCheck = await applyTodoOccurrence(f.pmRoot, { id, dialect, expectedRevision: unchanged.revision, expectedTargetRevision: unchanged.targetRevision }, {
    author: "test-agent", async onTransition(step) { if (step === "before_release") await f.client.close(first.nextId!, "Peer completed after the equality check"); },
  });
  assert.equal(peerAfterCheck.code, "foreign_schedule");
  assert.equal(peerAfterCheck.status, "closed");
  assert.equal(peerAfterCheck.status, (await f.client.get(first.nextId!)).item.status);
});

test("stored source scheduling tokens are foreign when edited independently of native fields", async t => {
  const f = await fixture(t);
  for (const token of ["due:2026-12-01", "rec:+4w", "due:2026-12-01 due:2026-10-27", "checked"]) {
    const id = await f.source("raw-" + token.replace(/[^a-z0-9]/g, "-"));
    const first = await previewTodoOccurrence(f.pmRoot, { id, dialect });
    await applyTodoOccurrence(f.pmRoot, { id, dialect, expectedRevision: first.revision }, { author: "test-agent" });
    const target = (await f.client.get(first.nextId!)).item;
    const oldLine = String(target.todos_todotxt);
    const line = token === "checked" ? "x " + oldLine : token.startsWith("due:") ? oldLine.replace("due:2026-10-27", token) : oldLine.replace("rec:+1w", token);
    await f.client.update(first.nextId!, { field: ["todos_todotxt=" + line] });
    await f.client.update(id, { field: ['todos_kv={"rec":"+2w"}', "todos_todotxt=x Weekly rec:+2w due:2026-10-20"] });
    const preview = await previewTodoOccurrence(f.pmRoot, { id, dialect });
    assert.equal(preview.code, "foreign_schedule");
    assert.equal(preview.nextDue, "2026-10-27", "native due is reported independently of inconsistent text");
    const result = await applyTodoOccurrence(f.pmRoot, { id, dialect, expectedRevision: preview.revision, expectedTargetRevision: preview.targetRevision }, { author: "test-agent" });
    assert.equal(result.code, "foreign_schedule");
    assert.equal((await f.client.get(first.nextId!)).item.todos_todotxt, line);
    assert.equal((await f.client.get(first.nextId!)).item.deadline, "2026-10-27T00:00:00.000Z");
  }
});
