/** Import-created items use supported typed clears and retain explicit source scope. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";

for (const format of ["markdown", "jsonl", "todotxt", "todojson"] as const) {
  test(`typed scope clear: ${format} ignores ambient scope and preserves source values`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "todos-typed-clear-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const pmRoot = join(root, "tracker");
    const pm = new PmClient({ pmRoot, cwd: root, noExtensions: true, author: process.env.PM_AUTHOR });
    await pm.init("typed-clear");
    const anchor = await pm.create({ title: "Ambient scope", type: "Epic", assignee: "Peer" });
    await pm.update(anchor.item.id, { goal: anchor.item.id, objective: anchor.item.id, sprint: "ambient", release: "ambient" });
    await pm.focus(anchor.item.id);
    const input = join(root, "input");
    const content = format === "jsonl" ? `${JSON.stringify({ title: "Imported", status: "open", type: "Task" })}\n${JSON.stringify({ title: "Source sprint", status: "open", type: "Task", sprint: "source-sprint", assignee: "Source Agent" })}\n`
      : format === "todojson" ? JSON.stringify({ action: "list", todos: [{ id: 1, text: "Imported", done: false }], nextId: 2 })
      : format === "todotxt" ? "Imported\n" : "- [ ] Imported\n";
    await writeFile(input, content);
    const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
    const receipt = await harness.runImporter({ importer: "todos", args: [input], options: { format }, pmRoot });
    const result = receipt.result as { imported: number; skipped: number; dropped?: unknown[] };
    assert.equal(result.imported, format === "jsonl" ? 2 : 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.dropped, undefined);
    const rows = (await pm.listAllComplete({ includeBody: true })).items;
    const actual = rows.find(row => row.title === "Imported");
    assert.ok(actual);
    for (const field of ["parent", "blocked_by", "goal", "objective", "sprint", "release", "assignee"] as const) assert.equal(actual[field], undefined, `${format}/${field}`);
    assert.deepEqual(actual.dependencies ?? [], []);
    if (format === "jsonl") {
      const scoped = rows.find(row => row.title === "Source sprint");
      assert.equal(scoped?.sprint, "source-sprint");
      assert.equal(scoped?.assignee, "Source Agent");
    }
  });
}
