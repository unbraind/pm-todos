/** Real installed schemas must be shared by topology, snapshots, writes and recovery. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import * as core from "@unbrained/pm-cli/sdk";
import { applyTodoHierarchy, exportTodoHierarchy, applyTodoEditingSession, exportTodoEditingSession, applyTodoSourceSelection, exportTodoSourceSelection, applyTodoOccurrence, previewTodoOccurrence } from "../index.ts";
import { installSchemaFixture, readSchemaDocuments } from "../scripts/extension-schema-fixture.ts";
import { packExtension } from "./packed-fixture.ts";

/** Seed a plain tracker with a real schema extension and explicit native scope. */
async function fixture(t: test.TestContext, strict = false, suffix = "one") {
  const root = mkdtempSync(join(tmpdir(), "todos-extension-context-")), pmRoot = join(root, "tracker"), ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  t.after(() => { if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling; rmSync(root, { recursive: true, force: true }); });
  await core.init(undefined, {}, { pmRoot, noExtensions: true });
  const shape = await installSchemaFixture(core, root, pmRoot, suffix);
  // Use the actual package producer to declare all fields used by every path.
  await core.packageInstall(packExtension(root), { project: true }, { pmRoot });
  const client = new core.PmClient({ pmRoot, author: "schema-test" });
  if (strict) await client.config("project", "set", "schema_unknown_field_policy", "reject");
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const { item } = await client.create({ id: "schema-" + index, title: "Schema row " + index, ...(strict && index === 2 ? { status: "closed", closeReason: "Completed schema fixture" } : {}), type: index === 1 ? shape.type : "Task", parent: "none", blockedBy: "none", dep: [], sprint: "none", release: "none", field: [`${shape.note}=  opaque value  `, `${shape.payload}=${JSON.stringify({ values: [index, true, "CRLF\r\nvalue"], nested: { keep: "unchanged" } })}`] });
    ids.push(item.id);
  }
  return { root, pmRoot, client, ids, shape };
}
/** Compare native values and immutable histories, including unselected extension types. */
async function saved(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  return core.stableUpsertValue({ documents: await readSchemaDocuments(core, f.pmRoot, f.ids), histories: await Promise.all(f.ids.map(id => core.readHistoryEntries(core.getHistoryPath(f.pmRoot, id), id))) });
}

test("extension-defined intermediate types participate in SDK cycle validation and affected closure", async t => {
  const f = await fixture(t), [a, b, c] = f.ids;
  await f.client.update(b, { dep: [`id=${a},kind=blocked_by`, `id=${c},kind=blocks`] });
  const exported = await exportTodoHierarchy(f.pmRoot, [a, c], "blocked_by"), before = await saved(f);
  const text = `- [ ] Same <!-- pm-session:${c} -->\n  - [ ] Same <!-- pm-session:${a} -->\n`;
  for (const injected of [false, true]) for (const dryRun of [true, false]) {
    const result = await applyTodoHierarchy(f.pmRoot, exported.session, text, { author: "schema-test", dryRun, ...(injected ? { sdk: core, read: () => f.client.listAllComplete() } : {}) });
    assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.refusals[0].code, "cycle"); assert.equal(result.applied, 0);
    assert.equal(await saved(f), before);
  }
  // A valid move includes the unselected registered bridge and its child.
  await f.client.update(b, { parent: a });
  const child = await f.client.create({ title: "Bridge descendant", type: "Task", parent: b, blockedBy: "none", dep: [], sprint: "none", release: "none" });
  f.ids.push(child.item.id);
  const scoped = await exportTodoHierarchy(f.pmRoot, [a, c]);
  const moved = await applyTodoHierarchy(f.pmRoot, scoped.session, text, { author: "schema-test" });
  assert.equal(moved.ok, true, JSON.stringify(moved)); assert.equal(moved.applied, 1);
  assert.deepEqual(moved.affected, [...f.ids].sort());
  assert.equal((await readSchemaDocuments(core, f.pmRoot, [a]))[0].metadata.parent, c);
  const all = await exportTodoHierarchy(f.pmRoot, f.ids);
  assert.equal(all.skipped, 0); assert.equal(all.session.rows.length, 4);
});

test("registered foreign fields survive strict native hierarchy, editing sessions, source recovery and recurrence", async t => {
  const f = await fixture(t, true), [a, b, c] = f.ids;
  const originals = await readSchemaDocuments(core, f.pmRoot, f.ids);
  /** Check every foreign value through SDK read-back without local normalization. */
  const preserved = async () => {
    const current = await readSchemaDocuments(core, f.pmRoot, f.ids);
    for (const [index, doc] of current.entries()) for (const name of [f.shape.note, f.shape.payload]) assert.deepEqual(doc.metadata[name], originals[index].metadata[name]);
  };
  for (const relation of ["parent", "blocked_by"] as const) {
    const exported = await exportTodoHierarchy(f.pmRoot, f.ids, relation);
    assert.equal(exported.skipped, 0);
    const text = `- [ ] A <!-- pm-session:${a} -->\n  - [ ] B <!-- pm-session:${b} -->\n- [ ] C <!-- pm-session:${c} -->\n`;
    const preview = await applyTodoHierarchy(f.pmRoot, exported.session, text, { author: "schema-test", dryRun: true });
    const result = await applyTodoHierarchy(f.pmRoot, exported.session, text, { author: "schema-test" });
    assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.changed, preview.changed); assert.equal(result.applied, 1); await preserved();
    assert.equal((await applyTodoHierarchy(f.pmRoot, exported.session, text, { author: "schema-test" })).changed, 0); await preserved();
  }
  const editing = await exportTodoEditingSession(f.pmRoot);
  const edited = await applyTodoEditingSession(f.pmRoot, editing.session, editing.text.replace("Schema row 1", "Edited bridge"), { author: "schema-test" });
  assert.equal(edited.ok, true, JSON.stringify(edited)); assert.equal(edited.applied, 1); await preserved();
  const source = await exportTodoSourceSelection(f.pmRoot, { sources: [{ file: "one.txt", ids: [b] }, { file: "two.txt", ids: [] }] });
  const files = [{ file: "one.txt", text: "" }, { file: "two.txt", text: source.files[0].text }];
  const moved = await applyTodoSourceSelection(f.pmRoot, source.manifest, files, { author: "schema-test" });
  assert.equal(moved.ok, true, JSON.stringify(moved)); assert.equal(moved.applied, 1); await preserved();
  const replay = await applyTodoSourceSelection(f.pmRoot, source.manifest, files, { author: "schema-test" });
  assert.equal(replay.ok, true, JSON.stringify(replay)); assert.equal(replay.changed, 0); await preserved();
  const recovery = await exportTodoSourceSelection(f.pmRoot, { sources: [{ file: "one.txt", ids: [] }, { file: "two.txt", ids: [b] }] });
  const back = [{ file: "one.txt", text: recovery.files[1].text }, { file: "two.txt", text: "" }];
  let injected = false;
  const interrupted = await applyTodoSourceSelection(f.pmRoot, recovery.manifest, back, { author: "schema-test", async onTransition(context) {
    if (!injected && context.transition === "step_applied") { injected = true; throw new Error("Compensate schema fixture"); }
  } });
  assert.equal(injected, true); assert.equal(interrupted.ok, false); await preserved();
  const recovered = await applyTodoSourceSelection(f.pmRoot, recovery.manifest, back, { author: "schema-test" });
  assert.equal(recovered.ok, true, JSON.stringify(recovered)); await preserved();
  const settings = await core.readSettings(f.pmRoot);
  await core.runWithActiveExtensions({ path: f.pmRoot }, async () => {
    await core.mutateItem({ pmRoot: f.pmRoot, settings, id: c, author: "schema-test", op: "update", extensionFieldNames: core.getActiveExtensionRegistrations()!.item_fields.flatMap(entry => entry.fields.map(field => field.name)), mutate(document) {
      document.metadata.todos_todotxt = "x 2026-10-25 2026-10-01 Schema row 2 due:2026-10-25 rec:1w";
      document.metadata.todos_kv = { rec: "1w" };
      document.metadata.deadline = core.resolveIsoOrRelative("2026-10-25");
      document.metadata.todos_completion_date = "2026-10-25";
      return { changedFields: ["todos_todotxt", "todos_kv", "deadline", "todos_completion_date"] };
    } });
  });
  assert.equal((await previewTodoOccurrence(f.pmRoot, { id: b, dialect: "todotxt-weekly-v1" })).code, "not_done");
  const request = { id: c, dialect: "todotxt-weekly-v1" as const };
  const preview = await previewTodoOccurrence(f.pmRoot, request);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  await f.client.focus(a);
  const result = await applyTodoOccurrence(f.pmRoot, { ...request, expectedRevision: preview.revision }, { author: "schema-test" });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.created, 1); await preserved();
  const target = result.nextId!;
  const independent = (await readSchemaDocuments(core, f.pmRoot, [target]))[0].metadata;
  for (const key of ["parent", "blocked_by", "sprint", "release"]) assert.equal(independent[key], undefined);
  assert.deepEqual(independent.dependencies ?? [], []);
  await f.client.update(target, { field: [`${f.shape.note}=Foreign successor field`, `${f.shape.payload}={"successor":true}`] });
  await f.client.update(c, { field: ['todos_kv={"rec":"2w"}', "todos_todotxt=x 2026-10-25 2026-10-01 Schema row 2 due:2026-10-25 rec:2w"] });
  const reschedule = await previewTodoOccurrence(f.pmRoot, request);
  assert.equal(reschedule.ok, true, JSON.stringify(reschedule)); assert.equal(reschedule.action, "reschedule");
  const targetBefore = (await readSchemaDocuments(core, f.pmRoot, [target]))[0];
  const rescheduled = await applyTodoOccurrence(f.pmRoot, { ...request, expectedRevision: reschedule.revision, expectedTargetRevision: reschedule.targetRevision }, { author: "schema-test" });
  assert.equal(rescheduled.ok, true, JSON.stringify(rescheduled)); assert.equal(rescheduled.action, "rescheduled");
  const targetAfter = (await readSchemaDocuments(core, f.pmRoot, [target]))[0];
  for (const name of [f.shape.note, f.shape.payload]) assert.deepEqual(targetAfter.metadata[name], targetBefore.metadata[name]);
  await preserved();
  const counterfeit = await f.client.create({ title: "Counterfeit receipt", type: "Task", status: "closed", closeReason: "Closed foreign fixture", deadline: targetAfter.metadata.deadline, parent: "none", blockedBy: "none", dep: [], sprint: "none", release: "none", message: "pm-todos recurring occurrence v1 | explicit_unset=title", field: ["todos_kv=" + JSON.stringify(targetAfter.metadata.todos_kv), "todos_todotxt=x " + String(targetAfter.metadata.todos_todotxt), "todos_completion_date=2026-10-25"] });
  const foreignBefore = (await readSchemaDocuments(core, f.pmRoot, [counterfeit.item.id]))[0];
  assert.equal((await previewTodoOccurrence(f.pmRoot, { id: counterfeit.item.id, dialect: "todotxt-weekly-v1" })).code, "foreign_target");
  assert.deepEqual((await readSchemaDocuments(core, f.pmRoot, [counterfeit.item.id]))[0], foreignBefore);
  // Tight schema policy remains active; do not fix valid fields by allowing all keys.
  const located = await core.runWithActiveExtensions({ path: f.pmRoot }, () => core.locateItem(f.pmRoot, a)); assert.ok(located);
  const raw = readFileSync(located.itemPath, "utf8");
  writeFileSync(located.itemPath, raw.replace('title:', 'fixture_unregistered: 1\ntitle:'));
  const partial = await exportTodoHierarchy(f.pmRoot, [a, c]);
  assert.equal(partial.skipped, 1); assert.equal(partial.session.rows[0].id, c);
});

test("JSON and TOON CLI consumers retain foreign schemas without a git executable", async t => {
  const f = await fixture(t, true), [a, b, c] = f.ids;
  await f.client.update(b, { dep: [`id=${a},kind=blocked_by`, `id=${c},kind=blocks`] });
  const selection = join(f.root, "ids.json"), before = await saved(f);
  writeFileSync(selection, JSON.stringify([a, c]));
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: join(f.root, "no-executables"), PM_PATH: f.pmRoot, PM_GLOBAL_PATH: join(f.root, "global"), PM_AUTHOR: "schema-test", GIT_CEILING_DIRECTORIES: dirname(f.root) };
  for (const key of Object.keys(environment)) if (/token|secret|password|credential|api.?key|private.?key|access.?key|^NPM_MEDIA_SERVER$/i.test(key)) delete environment[key];
  for (const json of [true, false]) {
    const file = join(f.root, `cli-${json}.md`), session = join(f.root, `cli-${json}.json`);
    /** Run the real installed host and decode its chosen public transport. */
    const command = (args: string[], status = 0) => {
      const result = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", f.pmRoot, "todos", "hierarchy", ...args, ...(json ? ["--json"] : [])], { cwd: f.root, env: environment, encoding: "utf8", timeout: 60000 });
      assert.equal(result.status, status, result.stderr + result.stdout);
      return (json ? JSON.parse(result.stdout) : decodeToon(result.stdout)) as { ok: boolean; selected: number; skipped: number; applied: number; refusals: { code: string }[] };
    };
    const exported = command(["export", "--selection", selection, "--relation", "blocked_by", "--file", file, "--session", session]);
    assert.equal(exported.selected, 2); assert.equal(exported.skipped, 0);
    writeFileSync(file, `- [ ] Same <!-- pm-session:${c} -->\r\n  - [ ] Same <!-- pm-session:${a} -->\r\n`);
    for (const action of ["preview", "apply"]) {
      const refused = command([action, "--file", file, "--session", session], 1);
      assert.equal(refused.ok, false); assert.equal(refused.applied, 0); assert.equal(refused.refusals[0].code, "cycle");
      assert.equal(await saved(f), before);
    }
  }
});


test("concurrent workspace registries keep foreign type and field declarations isolated", async t => {
  const workspaces = [await fixture(t, true, "first"), await fixture(t, true, "second")];
  await Promise.all(workspaces.map(async f => {
    const [a, b, c] = f.ids, before = await readSchemaDocuments(core, f.pmRoot, f.ids);
    const exported = await exportTodoHierarchy(f.pmRoot, f.ids);
    assert.equal(exported.skipped, 0); assert.equal(exported.session.rows.length, 3);
    const result = await applyTodoHierarchy(f.pmRoot, exported.session, `- [ ] A <!-- pm-session:${a} -->\n  - [ ] B <!-- pm-session:${b} -->\n- [ ] C <!-- pm-session:${c} -->\n`, { author: "schema-test" });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.applied, 1);
    const after = await readSchemaDocuments(core, f.pmRoot, f.ids);
    for (const [index, document] of after.entries()) for (const key of [f.shape.note, f.shape.payload]) assert.deepEqual(document.metadata[key], before[index].metadata[key]);
    const peer = workspaces.find(candidate => candidate !== f)!;
    assert.equal(Object.hasOwn(after[1].metadata, peer.shape.note), false);
    assert.equal(after[1].metadata.type, f.shape.type);
    await f.client.focus(a);
    const input = "independent-import.md", title = "Independent " + f.shape.note;
    writeFileSync(join(f.root, input), `- [ ] ${title}\n`);
    const importEnvironment: NodeJS.ProcessEnv = { ...process.env, PM_AUTHOR: "schema-test", PM_GLOBAL_PATH: join(f.root, "global"), GIT_CEILING_DIRECTORIES: dirname(f.root) };
    for (const key of Object.keys(importEnvironment)) if (/token|secret|password|credential|api.?key|private.?key|access.?key|^NPM_MEDIA_SERVER$/i.test(key)) delete importEnvironment[key];
    const imported = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", f.pmRoot, "todos", "import", input, "--json"], { cwd: f.root, env: importEnvironment, encoding: "utf8", timeout: 60000 });
    assert.equal(imported.status, 0, imported.stderr + imported.stdout);
    const created = (await f.client.listAllComplete()).items.find(item => item.title === title); assert.ok(created);
    const stored = (await readSchemaDocuments(core, f.pmRoot, [created.id]))[0].metadata;
    for (const key of ["parent", "blocked_by", "sprint", "release"]) assert.equal(stored[key], undefined);
    assert.deepEqual(stored.dependencies ?? [], []);
  }));
});
