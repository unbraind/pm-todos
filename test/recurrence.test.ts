/** Real SDK recurrence, replay and deterministic competing-writer regressions. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PmClient, locateItem, readLocatedItem, readSettings, resolveRuntimeStatusRegistry, type PmCreateActionOptions, type PmUpdateActionOptions } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness, decodeToon } from "@unbrained/pm-cli/sdk/testing";
import extension, { applyTodoOccurrence, previewTodoOccurrence, type TodoRecurrenceResult, type TodoRecurrenceTransition } from "../index.ts";
import { packExtension } from "./packed-fixture.ts";

/** Install the packed artifact on a plain tracker, with no discoverable git parent. */
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "todos-recurrence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, "tracker");
  const env = { ...process.env, HOME: root, PM_AUTHOR: "test-agent", PM_GLOBAL_PATH: join(root, "global"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), PM_TELEMETRY_DISABLED: "1", GIT_CEILING_DIRECTORIES: dirname(root) };
  const cli = join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  /** Launch the actual host; optionally remove git and pm from executable lookup. */
  const command = (args: string[], restricted = false): string => execFileSync(process.execPath, [cli, "--pm-path", pmRoot, ...args], { cwd: root, env: { ...env, ...(restricted ? { PATH: join(root, "bin") } : {}) }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  command(["init", "--prefix", "fixture", "--defaults", "--agent-guidance", "skip", "--json"]);
  command(["package", "install", packExtension(root), "--project", "--json"]);
  mkdirSync(join(root, "bin"));
  copyFileSync(process.execPath, join(root, "bin", basename(process.execPath)));
  const client = new PmClient({ pmRoot, cwd: root, author: "test-agent" });
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "importers", "preflight"] });
  /** Create a completed native fidelity source without hand-normalizing SDK state. */
  const source = async (suffix: string, options: PmCreateActionOptions = {}) => {
    const line = "x 2026-10-25 (B) Weekly +project @context rec:+1w due:2026-10-20";
    return (await client.create({ id: "source-" + suffix.replaceAll("_", "-"), type: "Task", title: "Weekly", status: "closed", closeReason: "Completed test work", deadline: "2026-10-20", priority: 1, tags: "project,context", field: ["todos_todotxt=" + line, 'todos_kv={"rec":"+1w"}', "todos_completion_date=2026-10-25"], ...options })).item.id;
  };
  return { root, pmRoot, client, harness, source, env, cli, command };
}
const dialect = "todotxt-weekly-v1" as const;
/** Assert the public result cannot emit invalid numeric values or grow with the tracker. */
function receipt(result: TodoRecurrenceResult): void {
  assert.ok(Number.isFinite(result.created) && [0, 1].includes(result.created));
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
  assert.equal(preview.originalDue, "2026-10-20");
  assert.equal(preview.nextDue, "2026-10-27");
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
  assert.equal(chained.nextDue, "2026-11-03");
  assert.notEqual(chained.occurrence, preview.occurrence);
});

test("strict boundary, disabled bytes, dates, timezone and configured status roles", async t => {
  const f = await fixture(t);
  const id = await f.source("policy");
  const snapshot = (await f.client.get(id)).item;
  const invalid: unknown[] = [null, [], Array(3), "text", 1, Infinity, { id, dialect, extra: [] }, { id: "x".repeat(161) }, { id, dialect: "weekly" }, { id, expectedRevision: "old" }, { id: NaN }];
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
  assert.equal((await previewTodoOccurrence(f.pmRoot, { id: completion, dialect })).nextDue, "2026-11-08");
  const leap = await f.source("leap", { deadline: "2024-02-29", field: ["todos_todotxt=x Weekly rec:+1w due:2024-02-29", 'todos_kv={"rec":"+1w"}'] });
  assert.equal((await previewTodoOccurrence(f.pmRoot, { id: leap, dialect })).nextDue, "2024-03-07");
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
  const referenceRoot = join(f.root, "reference");
  const reference = new PmClient({ pmRoot: referenceRoot, cwd: f.root, author: "test-agent" });
  await reference.init("fixture", { defaults: true, agentGuidance: "skip" });
  await reference.packageInstall(join(f.root, "pm-todos-2026.10.25.tgz"), { project: true });
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
      const retry = await applyTodoOccurrence(activeRoot, { id: "fixture-model", dialect, expectedRevision: preview.revision }, { author: "test-agent" });
      assert.equal(retry.action, "unchanged");
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
