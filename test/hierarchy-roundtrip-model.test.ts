/** Seeded native-format state model: every existing transport must preserve repaired relations. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as core from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { exportTodoHierarchy, applyTodoHierarchy } from "../index.ts";
import { packExtension } from "./packed-fixture.ts";

/** Read the entire persisted document through the public SDK, including source metadata and native annotations. */
async function native(pmRoot: string, id: string) {
  const settings = await core.readSettings(pmRoot), located = await core.locateItem(pmRoot, id, settings.id_prefix, settings.item_format, core.resolveItemTypeRegistry(settings).type_to_folder);
  assert.ok(located);
  return (await core.readLocatedItem(located, { schema: settings.schema, extensionFieldNames: ["todos_todotxt", "todos_kv", "todos_creation_date", "todos_completion_date", "todos_source_created_at", "todos_source_updated_at"] })).document;
}

test("500 seeded native import/export/sync sequences preserve hierarchy and every untouched native field through SDK read-back", { timeout: 1200000 }, async t => {
  let seed = 0x1029abcf;
  const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
  const root = mkdtempSync(join(tmpdir(), "todos-native-model-")), previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  t.after(() => { if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling; process.exitCode = 0; rmSync(root, { recursive: true, force: true }); });
  const covered = new Set<string>(), artifact = packExtension(root);
  for (const format of ["markdown", "todotxt", "todojson", "jsonl", "checkbox"] as const) {
    const pmRoot = join(root, format, "tracker");
    await core.init(undefined, {}, { pmRoot, noExtensions: true });
    const client = new core.PmClient({ pmRoot, author: "roundtrip-model" });
    await client.packageInstall(artifact, { project: true });
    const sdk = core.createExtensionCommandSdk(pmRoot, client, "roundtrip-model");
    const active = `custom-${random(10000000)}`;
    await client.schemaAddStatus(active, { role: [random(2) ? "active" : "blocked"] });
    const parent = await client.create({ id: "model-parent", title: "Reference parent", type: "Feature", parent: "none", sprint: "none", release: "none", blockedBy: "none", dep: [] });
    const peer = await client.create({ id: "model-peer", title: "Reference peer", type: "Feature", parent: "none", sprint: "none", release: "none", blockedBy: "none", dep: [] });
    const child = await client.create({ id: "model-child", title: "Stable native row", status: active, type: "Task", parent: parent.item.id, sprint: "none", release: "none", blockedBy: "none", dep: [`id=${peer.item.id},kind=related`], priority: 2, tags: "todo", deadline: "2026-12-01", description: "Preserved native description todo-id:1", body: "Preserved body", comment: ["text=Seeded comment"], note: ["text=Seeded note"], file: ["path=example.ts"], doc: ["path=README.md"], test: ["command=node --version"], acceptanceCriteria: "Retain repaired relations" });
    const id = child.item.id, ids = [parent.item.id, peer.item.id, id];
    const baseline = await native(pmRoot, id), model = structuredClone(baseline);
    const file = join(root, format, "exchange"), output = join(root, format, "exported");
    const settings = await core.readSettings(pmRoot);
    const inputVersions: { text: string; priority: number; deadline: string }[] = [];
    for (let sequence = 0; sequence < 100; sequence++) {
      const priority = format === "todojson" ? 2 : random(5), deadline = format === "todojson" ? "2026-12-01" : `2026-12-${String(1 + random(28)).padStart(2, "0")}`;
      const line = `(p${priority}) Stable native row due:${deadline}`;
      let text: string;
      if (format === "markdown" || format === "checkbox") text = `- [ ] ${line} [Task] <!-- ${id} -->\n`;
      else if (format === "todotxt") text = `(${String.fromCharCode(65 + priority)}) Stable native row +todo due:${deadline}\n`;
      else if (format === "todojson") text = JSON.stringify({ action: "list", todos: [{ id: 1, text: "Stable native row", done: false }], nextId: 2 }) + "\n";
      else text = JSON.stringify({ id, title: "Stable native row", status: active, type: "Task", priority, tags: ["todo"], deadline, description: baseline.metadata.description, created_at: "2020-01-01T00:00:00.000Z", updated_at: "2020-01-02T00:00:00.000Z", creationDate: "2020-01-01", kv: { note: "retained" } }) + "\n";
      const op = (random(4) + sequence) % 4;
      let incoming = { text, priority, deadline };
      if (op === 3 && inputVersions.length) incoming = inputVersions[random(inputVersions.length)];
      else inputVersions.push(incoming);
      writeFileSync(file, sequence % 2 ? incoming.text : incoming.text.replaceAll("\n", "\r\n"));
      // Repair a native relation during the operation stream, then require every
      // legacy transport to preserve it, even when replaying old portable input.
      if (sequence % 10 === 0) {
        const exported = await exportTodoHierarchy(pmRoot, ids);
        const parentId = random(2) ? ids[0] : ids[1];
        const edited = `- [ ] Parent <!-- pm-session:${ids[0]} -->\n${parentId === ids[0] ? `  - [ ] Child <!-- pm-session:${id} -->\n` : ""}- [ ] Peer <!-- pm-session:${ids[1]} -->\n${parentId === ids[1] ? `  - [ ] Child <!-- pm-session:${id} -->\n` : ""}`;
        const repaired = await applyTodoHierarchy(pmRoot, exported.session, edited, { author: "roundtrip-model" });
        assert.equal(repaired.ok, true, JSON.stringify(repaired)); model.metadata.parent = parentId;
      }
      await client.focus(peer.item.id);
      const options = { format, upsert: true, sectionTags: false, status: active, metadata: true, type: "Task" };
      // Both importer names and sync share the real native write path.
      if (op % 3 === 0) { await harness.runImporter({ importer: "todos", args: [file], options, pmRoot }); covered.add(`${format}:import`); }
      else if (op % 3 === 1) { await harness.runImporter({ importer: "todos-import", args: [file], options, pmRoot }); covered.add(`${format}:legacy`); }
      else { await harness.runCommand({ command: "todos sync", args: [file], options, pmRoot }); covered.add(`${format}:sync`); }
      assert.notEqual(process.exitCode, 1, "Native import must not silently drop a record");
      const read = await native(pmRoot, id);
      model.metadata.priority = incoming.priority as 0 | 1 | 2 | 3 | 4; model.metadata.deadline = core.resolveIsoOrRelative(incoming.deadline);
      if (format === "jsonl") {
        model.metadata.todos_source_created_at = "2020-01-01T00:00:00.000Z"; model.metadata.todos_source_updated_at = "2020-01-02T00:00:00.000Z";
        model.metadata.todos_creation_date = "2020-01-01"; model.metadata.todos_kv = { note: "retained" };
      }
      // Core timestamps are nondeterministic. Verify them against SDK history,
      // while every value owned by the adapter/model is compared exactly.
      const history = await core.readHistoryEntries(core.getHistoryPath(pmRoot, id), id);
      assert.equal(read.metadata.updated_at, history.at(-1)?.ts); assert.ok(core.verifyHistoryEntries(history, read).ok);
      for (const key of new Set([...Object.keys(read.metadata), ...Object.keys(model.metadata)])) if (key !== "updated_at") assert.deepEqual((read.metadata as unknown as Record<string, unknown>)[key], (model.metadata as unknown as Record<string, unknown>)[key], `${format}/${sequence}: ${key}`);
      assert.equal(read.body, model.body);
      assert.equal((await core.listAllComplete({}, { pmRoot })).items.length, 3, "A replay cannot duplicate a native item");
      // Every registered producer output must validate before returning to the
      // actual importer/sync path, including tasklist's Markdown projection.
      const outputFormat = format === "markdown" && sequence % 2 ? "tasklist" : format;
      await harness.runExporter({ exporter: "todos", options: { format: outputFormat, output, filter: "type=Task", metadata: true }, pmRoot });
      const produced = readFileSync(output, "utf8");
      assert.ok(produced.length);
      await harness.runCommand({ command: "todos validate", args: [output], options: { format: outputFormat === "tasklist" ? "markdown" : outputFormat }, pmRoot, sdk });
      // Re-import the producer output and compare every native field again.
      await harness.runImporter({ importer: "todos", args: [output], options, pmRoot });
      const roundtrip = await native(pmRoot, id);
      for (const key of new Set([...Object.keys(read.metadata), ...Object.keys(roundtrip.metadata)])) if (key !== "updated_at") assert.deepEqual((roundtrip.metadata as unknown as Record<string, unknown>)[key], (read.metadata as unknown as Record<string, unknown>)[key], `${format}/${sequence}: producer ${key}`);
      assert.equal(roundtrip.body, model.body);
    }
    assert.equal((await core.readSettings(pmRoot)).item_format, settings.item_format);
    t.diagnostic(`${format}: 100 model sequences`);
  }
  assert.equal(covered.size, 15);
});
