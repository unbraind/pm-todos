/** Seed an interrupted rollback through an installed artifact's public SDK, never a copied planner. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as CoreSdk from "@unbrained/pm-cli/sdk";
import type * as PackageSdk from "../index.ts";
import { interruptSourceRollback } from "./source-recovery-fixture.ts";

const [pmRoot, manifestPath, editingDirectory, mode] = process.argv.slice(2);
assert.ok(mode === undefined || mode === "poison" || mode === "verify-poison");
const requireConsumer = createRequire(import.meta.url);
const core = requireConsumer("@unbrained/pm-cli/sdk") as typeof CoreSdk;
const api = requireConsumer("..") as Pick<typeof PackageSdk, "parseTodoSourceManifest" | "applyTodoSourceSelection">;
const manifest = api.parseTodoSourceManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
const files = manifest.sources.map(source => ({ file: source.file, text: readFileSync(join(editingDirectory, source.file), "utf8") }));
const ids = manifest.sources.flatMap(source => source.rows.map(row => row.id));
const extensionFieldNames = [...Object.keys(manifest.session.entries[0].fieldDigests).filter(field => field.startsWith("todos_")), "todos_source_file"];
/** Compare full native values, bodies and history through the consumer SDK's own canonicalizer. */
async function state(): Promise<string> {
  const settings = await core.readSettings(pmRoot);
  const documents = [];
  for (const id of ids) {
    const located = await core.locateItem(pmRoot, id, settings.id_prefix, settings.item_format, core.resolveItemTypeRegistry(settings).type_to_folder);
    assert.ok(located);
    const { document } = await core.readLocatedItem(located, { schema: settings.schema, extensionFieldNames });
    documents.push({ document: core.canonicalDocument(document, { schema: settings.schema, extensionFieldNames }), history: await core.readHistoryEntries(core.getHistoryPath(pmRoot, id), id) });
  }
  return core.stableUpsertValue(documents);
}
const savedState = join(editingDirectory, ".foreign-state");
if (mode === "verify-poison") {
  assert.equal(await state(), readFileSync(savedState, "utf8"));
  console.log(JSON.stringify({ foreign_preserved: true, selected: ids.length }));
} else {
const result = await interruptSourceRollback(api.applyTodoSourceSelection, pmRoot, manifest, files, { sdk: core, point: "step_compensated" });
assert.equal(result.applied, 1);
const journal = JSON.parse(readFileSync(join(pmRoot, "transactions", "sdk", result.transaction + ".json"), "utf8")) as { status: string; startedStepIds: string[] };
assert.equal(journal.status, "compensating"); assert.equal(journal.startedStepIds.length, 1);
if (mode === "poison") {
  const id = ids.at(-1)!;
  const history = await core.readHistoryEntries(core.getHistoryPath(pmRoot, id), id);
  assert.ok(history.at(-1)?.message?.endsWith(":compensate"), "poison must target an actually compensated native step");
  const message = history.find(entry => entry.message?.endsWith(":apply"))!.message!;
  await core.mutateItem({ pmRoot, settings: await core.readSettings(pmRoot), id, op: "update", author: "peer-agent", message, extensionFieldNames,
    mutate(document) { document.metadata.todos_source_file = "peer.txt"; return { changedFields: ["todos_source_file"] }; },
  });
  writeFileSync(savedState, await state(), { flag: "wx" });
}
console.log(JSON.stringify({ interrupted: true, retained: result.applied, transaction: result.transaction, poisoned: mode === "poison" }));
}
