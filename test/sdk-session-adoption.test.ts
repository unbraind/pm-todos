/** Executable SDK adoption blockers and retained session integrity guarantees. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  commitItemMutations, create, get, init, locateItem, mutateItem, previewItemMutations,
  readHistoryAnalyticsWindow, readSettings, type BulkItemUpdateMutation,
} from "@unbrained/pm-cli/sdk";
import { applyTodoEditingSession, exportTodoEditingSession } from "../index.ts";

/** Create a real tracker outside git with no installed extension registrations. */
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "todos-sdk-adoption-"));
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  t.after(() => {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    rmSync(root, { recursive: true, force: true });
  });
  const pmRoot = join(root, "tracker");
  await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
  const { item } = await create({ title: "Original", type: "Task", author: "test-agent" }, { pmRoot });
  const id = String(item.id);
  return { pmRoot, id, history: join(pmRoot, "history", `${id}.jsonl`) };
}

test("SDK adoption blocker: transaction field options require installed extension registrations", async t => {
  const { pmRoot, id, history } = await fixture(t);
  const before = readFileSync(history, "utf8");
  const options = {
    pmRoot, transactionId: "session-field-probe", author: "test-agent",
    mutations: [{ op: "update" as const, id, options: { title: "Edited", field: ["todos_todotxt=Edited"] } }],
  };
  await assert.rejects(previewItemMutations(options), /todos_todotxt is not declared/);
  await assert.rejects(commitItemMutations(options), /todos_todotxt is not declared/);
  assert.equal((await get(id, {}, { pmRoot })).item.title, "Original");
  assert.equal(readFileSync(history, "utf8"), before);
  const exported = await exportTodoEditingSession(pmRoot);
  const receipt = await applyTodoEditingSession(pmRoot, exported.session, exported.text.replace("Original", "Edited"), { author: "test-agent" });
  assert.equal(receipt.applied, 1);
  assert.equal((await get(id, {}, { pmRoot })).item.todos_todotxt, "(C) Edited");
});

test("SDK adoption blocker: matching title alone misses a concurrent source conflict", async t => {
  const { pmRoot, id } = await fixture(t);
  const exported = await exportTodoEditingSession(pmRoot);
  const mutation: BulkItemUpdateMutation = {
    op: "update", id, match: { key: "title", value: "Original" }, options: { title: "Edited" },
  };
  const options = { pmRoot, transactionId: "session-match-probe", author: "test-agent", mutations: [mutation] };
  assert.equal((await previewItemMutations(options)).validated, true);
  await mutateItem({
    pmRoot, settings: await readSettings(pmRoot), id, op: "update", author: "test-agent",
    extensionFieldNames: ["todos_todotxt"],
    mutate(document) {
      document.metadata.todos_todotxt = "(C) Original note:concurrent";
      return { changedFields: ["todos_todotxt"] };
    },
  });
  const retained = await applyTodoEditingSession(pmRoot, exported.session, exported.text.replace("Original", "Edited"), { author: "test-agent" });
  assert.equal(retained.applied, 0);
  assert.equal(retained.refusals[0].code, "field_conflict");
  assert.equal(retained.refusals[0].field, "todos_todotxt");
  // Counterexample: the proposed single-field SDK guard admits that stale edit.
  assert.equal((await commitItemMutations(options)).status, "committed");
  const item = (await get(id, {}, { pmRoot })).item;
  assert.equal(item.title, "Edited");
  assert.equal(item.todos_todotxt, "(C) Original note:concurrent");
});

test("session apply detects corrupt history after the SDK event cache is primed", async t => {
  const { pmRoot, id, history } = await fixture(t);
  const exported = await exportTodoEditingSession(pmRoot);
  const cached = await readHistoryAnalyticsWindow(pmRoot, { since: "2000-01-01" });
  assert.ok(cached.events.some(event => event.item_id === id));
  const entries = readFileSync(history, "utf8").trimEnd().split("\n");
  const entry = JSON.parse(entries[0]) as Record<string, unknown>;
  entry.after_hash = "0".repeat(64);
  entries[0] = JSON.stringify(entry);
  writeFileSync(history, entries.join("\n") + "\n");
  const corrupted = readFileSync(history, "utf8");
  const before = (await get(id, {}, { pmRoot })).item;
  const receipt = await applyTodoEditingSession(pmRoot, exported.session, exported.text.replace("Original", "Edited"), { author: "test-agent" });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.applied, 0);
  assert.equal(receipt.refusals[0].code, "write_failed");
  assert.deepEqual((await get(id, {}, { pmRoot })).item, before);
  assert.equal(readFileSync(history, "utf8"), corrupted);
});

test("session apply verifies the locked item against history before merging an independent edit", async t => {
  const { pmRoot, id, history } = await fixture(t);
  const exported = await exportTodoEditingSession(pmRoot);
  const located = await locateItem(pmRoot, id);
  assert.ok(located);
  const drifted = readFileSync(located.itemPath, "utf8").replace("Original", "Drifted");
  writeFileSync(located.itemPath, drifted);
  const before = readFileSync(history, "utf8");
  const receipt = await applyTodoEditingSession(pmRoot, exported.session, exported.text.replace("(C)", "(A)"), { author: "test-agent" });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.applied, 0);
  assert.equal(receipt.refusals[0].code, "write_failed");
  assert.equal(readFileSync(located.itemPath, "utf8"), drifted);
  assert.equal(readFileSync(history, "utf8"), before);
});

for (const damage of ["missing", "empty", "invalid_json"] as const) {
  test(`session apply refuses ${damage} history without appending a new chain`, async t => {
    const { pmRoot, id, history } = await fixture(t);
    const exported = await exportTodoEditingSession(pmRoot);
    const located = await locateItem(pmRoot, id);
    assert.ok(located);
    const before = readFileSync(located.itemPath, "utf8");
    if (damage === "missing") rmSync(history);
    else writeFileSync(history, damage === "empty" ? "" : "{broken\n");
    const receipt = await applyTodoEditingSession(pmRoot, exported.session, exported.text.replace("Original", "Edited"), { author: "test-agent" });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.applied, 0);
    assert.equal(receipt.refusals[0].code, "write_failed");
    assert.equal(readFileSync(located.itemPath, "utf8"), before);
    if (damage === "missing") assert.throws(() => readFileSync(history), { code: "ENOENT" });
    else assert.equal(readFileSync(history, "utf8"), damage === "empty" ? "" : "{broken\n");
  });
}
