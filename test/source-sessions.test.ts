/** Real, non-git SDK acceptance plus a seeded independent state machine. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import * as core from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { applyTodoSourceSelection as apply, exportTodoSourceSelection as checkout, parseTodoSourceManifest, TodoSourceError, type TodoSourceFile, type TodoSourceManifest, type TodoSourceResult, serializeTodoTxtLine, type PmItem } from "../index.ts";

/** All native fields absent from todo.txt must survive every operation exactly. */
const PRESERVED = ["status", "type", "description", "assignee", "parent", "sprint", "release", "dependencies", "estimate_minutes", "acceptance_criteria", "comments", "notes", "files", "tests", "docs", "created_at", "todos_source_created_at", "todos_source_updated_at"];
/** Keep all numeric receipts inside their documented domain, including refusals. */
function numbers(result: TodoSourceResult): void {
  for (const field of ["files", "selected", "changed", "applied", "moved", "unchanged"] as const) assert.ok(Number.isSafeInteger(result[field]) && result[field] >= 0 && result[field] <= (field === "files" ? 32 : 1000));
  assert.ok(result.refusals.length <= 20);
}
/** Initialize a plain tracker; never rely on an enclosing git repository. */
async function fixture(t: test.TestContext, count = 3) {
  const root = mkdtempSync(join(tmpdir(), "todos-source-test-")), pmRoot = join(root, "tracker");
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  t.after(() => { if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling; rmSync(root, { recursive: true, force: true }); });
  await core.init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
  const client = new core.PmClient({ pmRoot, cwd: root, author: "selection-test" });
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const { item } = await client.create({ id: `source-row-${n}`, title: `Original row ${n}`, type: "Task", priority: 2, tags: "project", parent: n ? ids[0] : "none", sprint: "none", release: "none", description: `Preserved description ${n}`, body: `Preserved body ${n}`, comment: ["text=Seeded comment"], note: ["text=Seeded note"], file: ["path=example.ts"], doc: ["path=README.md"], test: ["command=node --version"], dep: n > 1 ? [`id=${ids[n-1]},kind=blocked_by`] : [] });
    ids.push(item.id);
  }
  const selection = { sources: [{ file: "one.txt", ids: ids.slice(0, 1) }, { file: "two.txt", ids: ids.slice(1, 2) }] };
  return { root, pmRoot, client, ids, selection };
}
/** Move a line as an editor would, preserving its sole stable identity. */
function move(files: TodoSourceFile[], id: string): void {
  let found = "", previous = -1;
  for (const [index, file] of files.entries()) {
    file.text = file.text.split(/\r?\n/).filter(line => {
      if (line.endsWith(`pm-session:${id}`)) { found = line; previous = index; return false; }
      return !!line;
    }).join("\n") + "\n";
  }
  assert.ok(found); files[1 - previous].text += found + "\n";
}
/** Read item and body through the SDK, never a package normalization oracle. */
async function state(client: core.PmClient, ids: string[]) {
  return Promise.all(ids.map(async id => { const read = await client.get(id, { depth: "deep" }); return { item: read.item, body: read.item.body }; }));
}

test("moving one row updates ownership exactly once; unselected rows stay outside scope", async t => {
  const f = await fixture(t), untouched = await f.client.get(f.ids[2]);
  const exported = await checkout(f.pmRoot, f.selection, { sdk: core });
  assert.deepEqual(parseTodoSourceManifest(exported.manifest), exported.manifest);
  move(exported.files, f.ids[0]);
  const before = await state(f.client, f.ids);
  const preview = await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test", dryRun: true });
  assert.equal(preview.ok, true); assert.deepEqual(await state(f.client, f.ids), before);
  const receipt = await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test", sdk: core });
  assert.equal(receipt.ok, true); assert.equal(receipt.changed, 2); numbers(receipt);
  assert.equal((await f.client.get(f.ids[0])).item.todos_source_file, "two.txt");
  assert.deepEqual(await f.client.get(f.ids[2]), untouched);
  const history = readFileSync(join(f.pmRoot, "history", `${f.ids[0]}.jsonl`), "utf8");
  const replay = await apply(f.pmRoot, exported.manifest, exported.files, { author: "peer-agent" });
  assert.equal(replay.ok, true); assert.equal(replay.changed, 0); assert.equal(replay.applied, 0);
  const variants = exported.files.map(file => ({ ...file, text: file.text.replace(/ /g, "\t  ").replace(/\n/g, "\r\n") }));
  assert.equal((await apply(f.pmRoot, exported.manifest, variants, { author: "peer-agent" })).changed, 0);
  assert.equal(readFileSync(join(f.pmRoot, "history", `${f.ids[0]}.jsonl`), "utf8"), history);
});

test("duplicate ownership refuses before writes, and a stale unchanged second file prevents all application", async t => {
  const f = await fixture(t);
  await assert.rejects(checkout(f.pmRoot, { sources: [{ file: "one.txt", ids: [f.ids[0]] }, { file: "two.txt", ids: [f.ids[0]] }] }), { code: "duplicate_ownership" });
  const exported = await checkout(f.pmRoot, f.selection);
  const duplicate = structuredClone(exported.files); duplicate[1].text += duplicate[0].text;
  const before = await state(f.client, f.ids);
  assert.equal((await apply(f.pmRoot, exported.manifest, duplicate, { author: "selection-test" })).refusals[0].code, "duplicate_ownership");
  assert.deepEqual(await state(f.client, f.ids), before);
  exported.files[0].text = exported.files[0].text.replace("Original", "Edited");
  await f.client.update(f.ids[1], { description: "Concurrent edit outside todo.txt" });
  const staleBefore = await state(f.client, f.ids);
  const refusal = await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test" });
  assert.equal(refusal.ok, false); assert.equal(refusal.refusals[0].code, "stale_revision"); assert.equal(refusal.applied, 0);
  assert.deepEqual(await state(f.client, f.ids), staleBefore);
});

test("ABA revisions and a peer edit during interrupted recovery cannot replay a frozen selection", async t => {
  const f = await fixture(t), exported = await checkout(f.pmRoot, f.selection);
  const original = (await f.client.get(f.ids[1])).item.title;
  await f.client.update(f.ids[1], { title: "Temporary ABA title" });
  await f.client.update(f.ids[1], { title: original });
  assert.equal((await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test" })).refusals[0].code, "stale_revision");
  const fresh = await checkout(f.pmRoot, f.selection);
  const interrupted = await apply(f.pmRoot, fresh.manifest, fresh.files, { author: "selection-test", onTransition(context) {
    if (context.transition === "step_recorded") throw new core.WorkspaceTransactionInterruptedError();
  } });
  assert.equal(interrupted.ok, false);
  await f.client.update(f.ids[1], { description: "Peer during crash recovery" });
  const before = await state(f.client, f.ids);
  assert.equal((await apply(f.pmRoot, fresh.manifest, fresh.files, { author: "selection-test" })).refusals[0].code, "stale_revision");
  assert.deepEqual(await state(f.client, f.ids), before);
});

test("two real agents on one tracker serialize ownership and report the peer's success truthfully", async t => {
  const f = await fixture(t), exported = await checkout(f.pmRoot, f.selection);
  move(exported.files, f.ids[0]);
  const results = await Promise.all(["agent-one", "agent-two"].map(author => apply(f.pmRoot, exported.manifest, exported.files, { author })));
  assert.ok(results.every(result => result.ok), JSON.stringify(results));
  assert.deepEqual(results.map(result => result.applied).sort(), [0, 2]);
  assert.equal((await f.client.get(f.ids[0])).item.todos_source_file, "two.txt");
  const history = await core.readHistoryEntries(core.getHistoryPath(f.pmRoot, f.ids[0]), f.ids[0]);
  assert.equal(history.filter(entry => entry.message?.startsWith("pm-todos-source-v1:")).length, 1);
});

test("one unsupported row fails alone during export, retaining all valid rows", async t => {
  const f = await fixture(t);
  await f.client.update(f.ids[1], { title: "Reserved +metadata title" });
  const exported = await checkout(f.pmRoot, f.selection);
  assert.equal(exported.skipped, 1); assert.equal(exported.refusals[0].id, f.ids[1]);
  assert.equal(exported.manifest.session.entries.length, 1);
  parseTodoSourceManifest(exported.manifest);
  assert.equal((await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test" })).ok, true);
});

test("new unsafe metadata refuses while previously persisted source strings and ordinary keys remain readable", async t => {
  const f = await fixture(t);
  const legacy = "(C) Original row 0 __proto__:historical";
  await core.mutateItem({ pmRoot: f.pmRoot, settings: await core.readSettings(f.pmRoot), id: f.ids[0], author: "selection-test", op: "update", extensionFieldNames: ["todos_todotxt"], mutate(document) {
    document.metadata.todos_todotxt = legacy;
    return { changedFields: ["todos_todotxt"] };
  } });
  const exported = await checkout(f.pmRoot, { sources: [{ file: "constructor", ids: [f.ids[0]] }] });
  assert.equal((await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test" })).ok, true);
  assert.equal((await f.client.get(f.ids[0])).item.todos_todotxt, legacy);
  const fresh = await checkout(f.pmRoot, { sources: [{ file: "constructor", ids: [f.ids[0]] }] });
  const bad = structuredClone(fresh.files); bad[0].text = bad[0].text.replace(" pm-session:", " __proto__:new pm-session:");
  const before = await state(f.client, f.ids);
  assert.equal((await apply(f.pmRoot, fresh.manifest, bad, { author: "selection-test" })).refusals[0].code, "session_refused");
  assert.deepEqual(await state(f.client, f.ids), before);
});

test("omissions, extra files, foreign owners, lifecycle changes and history damage refuse with remedies", async t => {
  const f = await fixture(t);
  const exported = await checkout(f.pmRoot, f.selection);
  const omitted = structuredClone(exported.files); omitted[1].text = "";
  assert.equal((await apply(f.pmRoot, exported.manifest, omitted, { author: "selection-test" })).refusals[0].code, "missing_row");
  assert.equal((await apply(f.pmRoot, exported.manifest, [...exported.files, { file: "foreign.txt", text: "" }], { author: "selection-test" })).refusals[0].code, "source_scope");
  const lifecycle = structuredClone(exported.files); lifecycle[0].text = "x " + lifecycle[0].text;
  assert.equal((await apply(f.pmRoot, exported.manifest, lifecycle, { author: "selection-test" })).refusals[0].code, "session_refused");
  assert.equal((await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test" })).ok, true);
  await assert.rejects(checkout(f.pmRoot, { sources: [{ file: "wrong.txt", ids: [f.ids[0]] }] }), { code: "foreign_owner" });
  const fresh = await checkout(f.pmRoot, f.selection);
  const history = join(f.pmRoot, "history", `${f.ids[0]}.jsonl`);
  writeFileSync(history, "");
  const result = await apply(f.pmRoot, fresh.manifest, fresh.files, { author: "selection-test" });
  assert.equal(result.refusals[0].code, "invalid_history"); numbers(result);
});

test("every forward transaction boundary rechecks all targets; failures compensate with append-only history", async t => {
  const points = ["prepared", "step_applied", "step_recorded", "committing"] as const;
  for (const point of points) {
    const f = await fixture(t), exported = await checkout(f.pmRoot, f.selection);
    const original = (await f.client.get(f.ids[0])).item;
    exported.files[0].text = exported.files[0].text.replace("Original", "Edited");
    let injected = false;
    const result = await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test", async onTransition(context) {
      if (context.transition === point && !injected) { injected = true; await f.client.update(f.ids[1], { description: "Peer success" }); }
    } });
    assert.equal(injected, true); assert.equal(result.ok, false);
    if (point === "committing") { assert.equal(result.refusals[0].code, "superseded"); assert.equal((await f.client.get(f.ids[1])).item.description, "Peer success"); continue; }
    assert.equal(result.applied, 0);
    const current = (await f.client.get(f.ids[0])).item;
    assert.equal(current.title, original.title); assert.equal(current.todos_source_file, undefined);
    assert.equal((await f.client.get(f.ids[1])).item.description, "Peer success");
    const log = readFileSync(join(f.pmRoot, "history", `${f.ids[0]}.jsonl`), "utf8");
    if (point !== "prepared") assert.match(log, /:compensate/);
    assert.equal((await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test" })).ok, false);
  }
});

test("recovery inspects native revisions after every crash boundary and never trusts a frozen journal", async t => {
  for (const point of ["prepared", "step_applied", "step_recorded", "committing", "committed"] as const) {
    const f = await fixture(t), exported = await checkout(f.pmRoot, f.selection);
    exported.files[0].text = exported.files[0].text.replace("Original", "Edited");
    let crashed = false;
    const interrupted = await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test", onTransition(context) {
      if (context.transition === point && !crashed) { crashed = true; throw new core.WorkspaceTransactionInterruptedError(); }
    } });
    assert.equal(interrupted.ok, false);
    const resumed = await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test" });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal((await f.client.get(f.ids[0])).item.title, "Edited row 0");
    await f.client.update(f.ids[1], { description: "Peer changed completed target" });
    const before = await state(f.client, f.ids);
    assert.equal((await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test" })).refusals[0].code, "stale_revision");
    assert.deepEqual(await state(f.client, f.ids), before);
  }
});

test("compensation refuses to overwrite a peer; every compensation boundary is observable and retry-safe", async t => {
  for (const point of ["compensating", "step_compensating", "step_compensated", "compensated"] as const) {
    const f = await fixture(t), exported = await checkout(f.pmRoot, f.selection);
    let failed = false, observed = false;
    const result = await apply(f.pmRoot, exported.manifest, exported.files, { author: "selection-test", async onTransition(context) {
      if (context.transition === "step_recorded" && !failed) { failed = true; throw new Error("Injected failure"); }
      if (context.transition === point) {
        observed = true;
        await f.client.update(f.ids[0], { description: `Peer at ${point}` });
      }
    } });
    assert.equal(observed, true); assert.equal(result.ok, false);
    assert.equal((await f.client.get(f.ids[0])).item.description, `Peer at ${point}`);
    if (point === "compensating" || point === "step_compensating") assert.equal(result.refusals[0].code, "superseded");
  }
});

test("schema fuzz rejects dense-array, extreme-number and prototype attacks before SDK acquisition", async t => {
  const f = await fixture(t), exported = await checkout(f.pmRoot, f.selection);
  const before = await state(f.client, f.ids);
  const extremes: unknown[] = [NaN, Infinity, -Infinity, Number.MAX_VALUE, -1, null, [], Array(2), {}, "x".repeat(300), "../escape", "/absolute", "constructor", "__proto__"];
  for (const value of extremes) {
    for (const corrupt of [
      { ...exported.manifest, version: value },
      { ...exported.manifest, sources: value },
      { ...exported.manifest, digest: value },
    ]) {
      const result = await apply("unavailable-tracker", corrupt, exported.files, { author: "selection-test" });
      assert.equal(result.ok, false); numbers(result); assert.equal(result.refusals[0].code, "invalid_input");
    }
    await assert.rejects(checkout("unavailable-tracker", { sources: [{ file: value, ids: [value] }] }), TodoSourceError);
  }
  const getter = Object.defineProperty({}, "version", { enumerable: true, get() { throw new Error("Accessor executed"); } });
  assert.equal((await apply("unavailable-tracker", getter, [], { author: "selection-test" })).refusals[0].code, "invalid_input");
  assert.equal((await apply(f.pmRoot, exported.manifest, Array(2), { author: "selection-test" })).ok, false);
  assert.equal((await apply(f.pmRoot, exported.manifest, exported.files, { author: "" })).ok, false);
  assert.deepEqual(await state(f.client, f.ids), before);
});

test("CLI export, preview, apply and typed refusals reuse the SDK selection contract", async t => {
  const f = await fixture(t), h = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
  const directory = join(f.root, "edits"), selection = join(f.root, "selection.json"), manifest = join(f.root, "manifest.json");
  mkdirSync(directory); writeFileSync(selection, JSON.stringify(f.selection));
  writeFileSync(join(directory, "unrelated.txt"), "Unrelated input without a session identity");
  const run = (action: string, options: Record<string, unknown>) => h.runCommand({ command: "todos sources", args: [action], options, pmRoot: f.pmRoot });
  t.after(() => { process.exitCode = 0; });
  assert.ok(await run("export", { directory, selection, manifest }));
  const before = await state(f.client, f.ids);
  assert.ok(await run("preview", { directory, manifest })); assert.deepEqual(await state(f.client, f.ids), before);
  assert.ok(await run("apply", { directory, manifest }));
  assert.equal((await f.client.get(f.ids[0])).item.todos_source_file, "one.txt");
  assert.equal(readFileSync(join(directory, "unrelated.txt"), "utf8"), "Unrelated input without a session identity");
  for (const options of [{}, { directory, manifest, selection }, { directory: "", manifest }, { directory, manifest: selection }]) { await run("preview", options); assert.equal(process.exitCode, 1); process.exitCode = 0; }
  await run("export", { directory, selection, manifest }); assert.equal(process.exitCode, 1); process.exitCode = 0;
  rmSync(join(directory, "one.txt")); symlinkSync(selection, join(directory, "one.txt"));
  await run("apply", { directory, manifest }); assert.equal(process.exitCode, 1); process.exitCode = 0;
});

test("500 seeded operation sequences compare every touched native field and preserved relationship through SDK read-back", { timeout: 1200000 }, async t => {
  const covered = new Set<number>();
  for (let cohort = 0; cohort < 10; cohort++) {
  const f = await fixture(t, 4);
  let seed = 0x1a2b3c4d + cohort;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const settings = await core.readSettings(f.pmRoot);
  // Random custom registry names deliberately do not encode their lifecycle meaning.
  for (let n = 0; n < 8; n++) {
    const roles = n % 4 === 0 ? ["active"] : n % 4 === 1 ? ["blocked"] : n % 4 === 2 ? ["terminal", "terminal_done"] : ["terminal", "terminal_canceled"];
    const name = `state-${random(1000000)}`;
    await f.client.schemaAddStatus(name, { role: roles });
    const id = f.ids[n % f.ids.length];
    await f.client.update(id, { status: name, ...(n % 4 > 1 ? { closeReason: "Seeded lifecycle fixture" } : {}) });
  }
  const registry = core.resolveRuntimeStatusRegistry((await core.readSettings(f.pmRoot)).schema);
  const initial = await state(f.client, f.ids);
  const model = new Map(initial.map(row => [row.item.id, structuredClone(row)]));
  const owner = new Map(f.ids.map((id, index) => [id, index % 2 === 0 ? "one.txt" : "two.txt"]));
  const claimed = new Set<string>();
  let older: Awaited<ReturnType<typeof checkout>> | undefined;
  const operations = new Set<number>();
  for (let sequence = 0; sequence < 50; sequence++) {
    const id = f.ids[random(f.ids.length)];
    const selected = sequence % 4 === 0 ? [id, f.ids[(f.ids.indexOf(id) + 1) % f.ids.length]] : [id];
    const selection = { sources: ["one.txt", "two.txt"].map(file => ({ file, ids: selected.filter(id => owner.get(id) === file) })) };
    const exported = await checkout(f.pmRoot, selection);
    parseTodoSourceManifest(JSON.parse(JSON.stringify(exported.manifest)) as unknown);
    const op = (random(13) + sequence) % 13; operations.add(op); covered.add(op);
    const expected = model.get(id)!;
    const files = structuredClone(exported.files);
    // Reference operations use exact valid values, not the implementation's parser or normalizer.
    let rendered = exported.manifest.session.entries.find(row => row.id === id)!.line;
    if (op === 0) { move(files, id); owner.set(id, owner.get(id) === "one.txt" ? "two.txt" : "one.txt"); }
    if (op === 1) expected.item.title = `Edited sequence ${sequence}`;
    if (op === 2) expected.item.priority = random(5) as 0 | 1 | 2 | 3 | 4;
    if (op === 3) expected.item.tags = [...(expected.item.tags ?? []), `tag${sequence}`].sort();
    if (op === 4) expected.item.deadline = `2026-11-${String(1 + random(28)).padStart(2, "0")}`;
    if (op === 5) { const key = ["note", "constructor", "toString"][random(3)]; expected.item.todos_kv = { ...(expected.item.todos_kv as Record<string, string> | undefined), [key]: `value${sequence}` }; }
    if (op === 6) expected.item.todos_creation_date = `2025-01-${String(1 + random(28)).padStart(2, "0")}`;
    if (op === 7 && registry.terminal_statuses.has(String(expected.item.status))) expected.item.todos_completion_date = `2026-01-${String(1 + random(28)).padStart(2, "0")}`;
    if (op === 8) await f.client.focus(f.ids[random(f.ids.length)]);
    if (op > 0 && op < 8) {
      const item = expected.item, done = registry.terminal_statuses.has(String(item.status));
      rendered = [done ? "x" : "", done ? item.todos_completion_date : "", `(${String.fromCharCode(65 + Number(item.priority))})`, item.todos_creation_date, item.title,
        ...(item.tags ?? []).map(tag => `+${tag}`), item.deadline ? `due:${String(item.deadline).slice(0, 10)}` : "",
        ...Object.entries((item.todos_kv ?? {}) as Record<string, string>).map(([key,value]) => `${key}:${value}`),
      ].filter(Boolean).join(" ");
    }
    if (op !== 0) for (const file of files) file.text = file.text.split(/\r?\n/).map(line => line.endsWith(`pm-session:${id}`) ? `${rendered} pm-session:${id}` : line).join("\n");
    if (op === 12) {
      const unsafe = structuredClone(files); unsafe.find(file => file.text.includes(`pm-session:${id}`))!.text = unsafe.find(file => file.text.includes(`pm-session:${id}`))!.text.replace(" pm-session:", " __proto__:value pm-session:");
      const before = await state(f.client, f.ids);
      assert.equal((await apply(f.pmRoot, exported.manifest, unsafe, { author: "model-agent" })).ok, false);
      assert.deepEqual(await state(f.client, f.ids), before);
    }
    // Exercise CRLF and horizontal whitespace only through the real edit path.
    if (sequence % 2 === 0) for (const file of files) file.text = file.text.replace(/ /g, "\t  ").replace(/\n/g, "\r\n");
    const preview = await apply(f.pmRoot, exported.manifest, files, { author: "model-agent", dryRun: true });
    const result = await apply(f.pmRoot, exported.manifest, files, { author: "model-agent" });
    assert.equal(result.ok, true, `cohort ${cohort} sequence ${sequence} op ${op}: ${JSON.stringify(result)}`); assert.equal(preview.ok, result.ok, `seed sequence ${sequence}`); numbers(result);
    assert.equal(preview.changed, result.changed);
    for (const selectedId of selected) claimed.add(selectedId);
    const current = await state(f.client, f.ids);
    for (const row of current) {
      const wanted = model.get(row.item.id)!;
      for (const key of PRESERVED) assert.deepEqual(row.item[key], wanted.item[key], `${sequence} preserved ${key}`);
      assert.equal(row.body, wanted.body);
      for (const key of ["title", "priority", "tags", "deadline", "todos_creation_date", "todos_completion_date", "todos_kv"]) assert.deepEqual(row.item[key], wanted.item[key], `${sequence} ${key}`);
      assert.equal(row.item.todos_source_file, claimed.has(row.item.id) ? owner.get(row.item.id) : undefined);
      if (row.item.todos_todotxt !== undefined) assert.equal(row.item.todos_todotxt, serializeTodoTxtLine(row.item as PmItem, "fidelity", registry));
    }
    const replay = await apply(f.pmRoot, exported.manifest, files, { author: "second-agent" });
    assert.equal(replay.ok, true); assert.equal(replay.changed, 0); numbers(replay);
    if (older && sequence % 7 === 0) {
      const before = await state(f.client, f.ids);
      const stale = await apply(f.pmRoot, older.manifest, older.files, { author: "replay-agent" });
      if (stale.ok) assert.equal(stale.changed, 0); assert.equal(stale.applied, 0); assert.deepEqual(await state(f.client, f.ids), before);
    }
    if (!older && result.changed) older = structuredClone(exported);

  }
  assert.equal(settings.item_format, (await core.readSettings(f.pmRoot)).item_format);
  t.diagnostic(`${(cohort + 1) * 50} seeded sequences verified`);
  }
  assert.equal(covered.size, 13);
});
