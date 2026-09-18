import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTodoContextSnapshot,
  buildTodojsonImportDescription,
  extractTodojsonSourceId,
  groupItems,
  parseFilterExpression,
  parseJsonl,
  parsePiTodoDetails,
  preflightValidateImportFiles,
  renderDefaultMarkdown,
  serializeJsonl,
  serializePiTodoDetails,
  serializeTodoTxtLine,
  sortItems,
  sortItemsForContext,
  validateTodoFile,
} from "../index.ts";

test("parseFilterExpression skips empty comma-separated tokens", () => {
  assert.deepEqual(parseFilterExpression("status=open,,type=Task,"), { status: "open", type: "Task" });
  assert.equal(parseFilterExpression(undefined), undefined);
});

test("sortItems covers missing, equal, and ordered priority/deadline values", () => {
  const priority = sortItems([
    { id: "missing", title: "Missing", status: "open" },
    { id: "high", title: "High", status: "open", priority: 0 },
    { id: "low", title: "Low", status: "open", priority: 2 },
    { id: "same", title: "Same", status: "open", priority: 2 },
  ], "priority");
  assert.deepEqual(priority.map((item) => item.id), ["high", "low", "same", "missing"]);
  const deadlines = sortItems([
    { id: "missing", title: "Missing", status: "open" },
    { id: "late", title: "Late", status: "open", deadline: "2026-07-01" },
    { id: "early", title: "Early", status: "open", deadline: "2026-06-01" },
    { id: "same", title: "Same", status: "open", deadline: "2026-06-01" },
  ], "deadline");
  assert.deepEqual(deadlines.map((item) => item.id), ["early", "same", "late", "missing"]);
  assert.deepEqual(sortItems([
    { id: "dated", title: "Dated", status: "open", deadline: "2026-06-01" },
    { id: "none", title: "None", status: "open" },
  ], "deadline").map((item) => item.id), ["dated", "none"]);
});

test("sortItemsForContext covers unknown values and final title ties", () => {
  const missingTitle = { id: "missing-title", title: undefined as unknown as string, status: "open" };
  const namedTitle = { id: "named-title", title: "Named", status: "open" };
  sortItemsForContext([missingTitle, namedTitle]);
  sortItemsForContext([namedTitle, missingTitle]);
  const sorted = sortItemsForContext([
    { id: "b", title: "Zulu", status: "mystery", priority: 1, deadline: "2026-06-10", updated_at: "2026-06-01" },
    { id: "a", title: "alpha", status: "mystery", priority: 1, deadline: "2026-06-10", updated_at: "2026-06-01" },
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ["a", "b"]);
});

test("buildTodoContextSnapshot uses unknown status/type fallbacks", () => {
  const snapshot = buildTodoContextSnapshot([
    { id: "unknown", title: "Unknown", status: " ", type: " " },
    { id: "open", title: "Open", status: "open", type: "Task" },
    { id: "missing-fields", title: "Missing", status: undefined as unknown as string, type: undefined },
  ], { limit: 3, nowIso: "2026-06-10T00:00:00.000Z" });
  assert.equal(snapshot.counts.byStatus["(unknown)"], 2);
  assert.equal(snapshot.counts.byType["(none)"], 2);
});

test("buildTodoContextSnapshot counts an invalid normalized deadline as without-deadline", () => {
  const snapshot = buildTodoContextSnapshot([
    { id: "bad-date", title: "Bad date", status: "open", deadline: "2026-99-99" },
  ], { limit: 1, nowIso: "2026-06-10T00:00:00.000Z" });
  assert.equal(snapshot.counts.withoutDeadline, 1);
});

test("validateTodoFile warns when a checkbox has only metadata and no text", () => {
  const result = validateTodoFile("- [ ] due:2026-07-01\n", "markdown");
  assert.ok(result.issues.some((issue) => issue.severity === "warning" && /no text/.test(issue.message)));
});

test("serializeTodoTxtLine handles absent tags and render metadata", () => {
  assert.equal(serializeTodoTxtLine({ id: "bare", title: "Bare", status: "open" }), "Bare");
  assert.match(renderDefaultMarkdown([{ id: "bare", title: "Bare", status: "open" }], "2026-06-10T00:00:00.000Z", true), /- \[ \] Bare/);
});

test("todojson provenance helpers cover absent and non-positive ids", () => {
  assert.equal(extractTodojsonSourceId("Imported from f line 1 (todo-id:0)"), undefined);
  assert.equal(buildTodojsonImportDescription(undefined, 4), "Imported from stdin line 4");
});

test("serializeJsonl omits empty optional arrays and objects", () => {
  const line = serializeJsonl([{ id: "empty", title: "Empty", status: "open", tags: [], kv: {} }]);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal(parsed.id, "empty");
  assert.equal("tags" in parsed, false);
  assert.equal("kv" in parsed, false);
});

test("parseJsonl preserves optional fields when present", () => {
  const [item] = parseJsonl(JSON.stringify({
    id: "pm-rich", title: "Rich", status: "open", description: "desc", type: "Task", priority: 1,
    tags: ["tag"], deadline: "2026-06-01", assignee: "a", sprint: "s",
    created_at: "2026-01-01", updated_at: "2026-01-02", creationDate: "2026-01-01",
    completionDate: "2026-01-03", kv: { key: "value" },
  }));
  assert.equal(item.description, "desc");
  assert.equal(item.created_at, "2026-01-01");
  assert.equal(item.completionDate, "2026-01-03");
});

test("serializePiTodoDetails resolves deterministic ids", () => {
  const output = JSON.parse(serializePiTodoDetails([
    { id: "b", title: "Same", status: "open", created_at: "2026-01-01" },
    { id: "a", title: "Same", status: "closed", created_at: "2026-01-01" },
  ])) as { todos: Array<{ id: number; done: boolean }> };
  assert.deepEqual(output.todos.map(({ id, done }) => ({ id, done })), [
    { id: 1, done: true },
    { id: 2, done: false },
  ]);
});

test("groupItems compares unassigned and assigned buckets", () => {
  const groups = groupItems([
    { id: "a", title: "A", status: "open" },
    { id: "b", title: "B", status: "open", sprint: "S1" },
  ], "sprint");
  assert.equal(groups.at(-1)?.heading, "(unassigned)");
});

test("preflight reports file-level todojson errors without line text", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-todos-preflight-"));
  const file = join(dir, "bad.json");
  writeFileSync(file, "not json");
  assert.throws(() => preflightValidateImportFiles([file], "todojson"), (err: unknown) => err instanceof Error && /file:/.test(err.message));
  rmSync(dir, { recursive: true, force: true });
});

test("parsePiTodoDetails rejects malformed payloads", () => {
  assert.throws(() => parsePiTodoDetails("not json"), /Invalid todojson/);
  assert.throws(() => parsePiTodoDetails(JSON.stringify({ action: "list", todos: "bad" })), /todos array/);
  assert.throws(() => parsePiTodoDetails(JSON.stringify({ action: "list", todos: [{ id: 1, text: 2, done: false }] })), /invalid text/);
});
