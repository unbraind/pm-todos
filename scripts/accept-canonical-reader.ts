/** Real, non-git acceptance of the host SDK's certified whole-corpus reader. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PmClient, certifyCompleteListResult } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";

const root = mkdtempSync(join(tmpdir(), "pm-todos-canonical-reader-"));
const client = new PmClient({ pmRoot: join(root, "tracker"), cwd: root, author: "reader-fixture" });
const harness = await createExtensionTestHarness(extension, {
  name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"],
});
try {
  await client.init();
  const created = await client.create({ title: "Tracked TODO", type: "Task", description: "Complete body fixture" });
  const input = join(root, "TODO.md");
  const output = join(root, "output.jsonl");
  writeFileSync(input, `- [ ] Tracked TODO <!-- ${created.item.id} -->\n`);
  await harness.runExporter({ exporter: "todos", pmRoot: join(root, "tracker"), options: { format: "jsonl", output } });
  const rows = readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.description, "Complete body fixture");
  const imported = await harness.runImporter({ importer: "todos", pmRoot: join(root, "tracker"), options: { file: input, upsert: true } });
  assert.equal((imported.result as Record<string, unknown>).updated, 1);
  const complete = certifyCompleteListResult(await client.listAllComplete({ includeBody: true }));
  assert.equal(complete.items.length, 1);
  console.log(JSON.stringify({ ok: true, exported: rows.length, updated: 1, certified: complete.items.length }));
} finally {
  await harness.deactivate();
  rmSync(root, { recursive: true, force: true });
}
