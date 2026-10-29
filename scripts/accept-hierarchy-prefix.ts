/** Verify durable graph prefixes through the installed artifact and its supported peer loader. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type * as Core from "@unbrained/pm-cli/sdk";
import type * as Package from "../index.ts";

const [pmRoot, file, sidecar, mode] = process.argv.slice(2);
const consumer = createRequire(import.meta.url), core = consumer("@unbrained/pm-cli/sdk") as typeof Core;
const api = consumer("..") as Pick<typeof Package, "exportTodoHierarchy">;
const settings = await core.readSettings(pmRoot);
const ids = ["prefix-x", "prefix-z", "prefix-y"].map(id => core.normalizeItemId(id, settings.id_prefix)), [x, z, y] = ids;
const client = new core.PmClient({ pmRoot, author: "prefix-owner" });
/** Certify both native topology and every selected history event without projected item reads. */
async function state(applied = false): Promise<string> {
  const documents = [];
  for (const id of ids) {
    const located = await core.locateItem(pmRoot, id, settings.id_prefix, settings.item_format, core.resolveItemTypeRegistry(settings).type_to_folder);
    assert.ok(located);
    const { document } = await core.readLocatedItem(located, { schema: settings.schema });
    const history = await core.readHistoryEntries(core.getHistoryPath(pmRoot, id), id);
    assert.equal(core.verifyHistoryEntries(history, document).ok, true);
    documents.push({ document, history });
  }
  const items = documents.map(entry => entry.document.metadata);
  for (const id of ids) assert.deepEqual(core.collectNewOrderingCycleWarnings([], items, id), []);
  if (applied) {
    assert.equal(items.find(item => item.id === x)!.blocked_by, y);
    assert.equal(items.find(item => item.id === z)!.blocked_by, undefined);
  }
  return core.stableUpsertValue(documents);
}
if (mode === "seed") {
  for (const id of ids) await client.create({ id, allowDuplicate: true, title: "Same label", type: "Task", parent: "none", blockedBy: "none", dep: [], sprint: "none", release: "none" });
  await client.update(z, { blockedBy: x, dep: [`id=${x},kind=blocked_by`, `id=${y},kind=blocks`] });
  await client.config("project", "set", "governance-ownership-enforcement", "strict");
  await client.claim(z);
  const exported = await api.exportTodoHierarchy(pmRoot, ids, "blocked_by");
  writeFileSync(sidecar, JSON.stringify(exported.session));
  writeFileSync(file, `- [ ] Same label <!-- pm-session:${y} -->\r\n  - [ ] Same label <!-- pm-session:${x} -->\r\n- [ ] Same label <!-- pm-session:${z} -->\r\n`);
  writeFileSync(file + ".before", await state());
} else if (mode === "verify-refused") {
  assert.equal(await state(), readFileSync(file + ".before", "utf8"));
  await client.release(z);
  // Releasing the claim changes its revision, so produce a new reviewed sidecar.
  writeFileSync(sidecar, JSON.stringify((await api.exportTodoHierarchy(pmRoot, ids, "blocked_by")).session));
} else {
  assert.equal(mode, "verify-applied");
  await state(true);
}
