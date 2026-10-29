/** Validate an installed package against foreign types and strict foreign fields. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type * as Core from "@unbrained/pm-cli/sdk";
import type * as Package from "../index.ts";
import { installSchemaFixture, readSchemaDocuments } from "./extension-schema-fixture.ts";

const [pmRoot, file, mode] = process.argv.slice(2), consumer = createRequire(import.meta.url);
const core = consumer("@unbrained/pm-cli/sdk") as typeof Core;
const api = consumer("..") as Pick<typeof Package, "exportTodoHierarchy" | "applyTodoHierarchy">;
const settings = await core.readSettings(pmRoot);
const ids = ["schema-a", "schema-bridge", "schema-c"].map(id => core.normalizeItemId(id, settings.id_prefix)), [a, b, c] = ids;
const client = new core.PmClient({ pmRoot, author: "schema-accept" });
/** Native SDK documents and full immutable histories provide the comparison model. */
async function state() {
  const documents = await readSchemaDocuments(core, pmRoot, ids);
  const histories = await Promise.all(ids.map(id => core.readHistoryEntries(core.getHistoryPath(pmRoot, id), id)));
  for (const [index, document] of documents.entries()) assert.equal(core.verifyHistoryEntries(histories[index], document).ok, true);
  return { documents, histories };
}
if (mode === "seed") {
  const shape = await installSchemaFixture(core, dirname(file), pmRoot, "packed");
  await client.config("project", "set", "schema_unknown_field_policy", "reject");
  for (const [index, id] of ids.entries()) await client.create({ id, allowDuplicate: true, title: "Same title", type: index === 1 ? shape.type : "Task", parent: "none", blockedBy: "none", dep: [], sprint: "none", release: "none", field: [`${shape.note}=  opaque field  `, `${shape.payload}=${JSON.stringify({ nested: { values: [index, true, "CRLF\r\nvalue"] } })}`] });
  await client.update(b, { dep: [`id=${a},kind=blocked_by`, `id=${c},kind=blocks`] });
  const exported = await api.exportTodoHierarchy(pmRoot, [a, c], "blocked_by");
  const edited = `- [ ] Same title <!-- pm-session:${c} -->\r\n  - [ ] Same title <!-- pm-session:${a} -->\r\n`;
  writeFileSync(file + ".blocked.json", JSON.stringify(exported.session));
  writeFileSync(file + ".blocked.md", edited); writeFileSync(file + ".edited", edited);
  writeFileSync(file + ".ids.json", JSON.stringify([a, c]));
  const refused = await api.applyTodoHierarchy(pmRoot, exported.session, edited, { author: "schema-accept", dryRun: true });
  assert.equal(refused.ok, false); assert.equal(refused.refusals[0].code, "cycle");
  writeFileSync(file + ".before", JSON.stringify(await state()));
} else {
  const before = JSON.parse(readFileSync(file + ".before", "utf8")) as Awaited<ReturnType<typeof state>>, current = await state();
  if (mode === "verify-refused") assert.deepEqual(current, before);
  else {
    assert.equal(mode, "verify-applied");
    assert.equal(current.documents[0].metadata.parent, c);
    for (const [index, document] of current.documents.entries()) {
      assert.equal(document.body, before.documents[index].body);
      for (const key of new Set([...Object.keys(document.metadata), ...Object.keys(before.documents[index].metadata)])) {
        if (index === 0 && ["parent", "updated_at"].includes(key)) continue;
        assert.deepEqual(document.metadata[key], before.documents[index].metadata[key]);
      }
      assert.deepEqual(current.histories[index].slice(0, before.histories[index].length), before.histories[index]);
      assert.equal(current.histories[index].length, before.histories[index].length + (index === 0 ? 1 : 0));
    }
  }
}
