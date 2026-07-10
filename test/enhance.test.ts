import assert from "node:assert/strict";
import test from "node:test";

import {
  serializeJsonl,
  parseJsonl,
  renderCheckboxMarkdown,
  renderTaskList,
  renderDefaultMarkdown,
  renderGroupedMarkdown,
  parseFilterExpression,
  parseMarkdownTodos,
  validateTodoFile,
  applyExportOrder,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// --format jsonl: serialize / parse / round-trip
// ---------------------------------------------------------------------------

test("serializeJsonl emits one compact JSON object per line with a trailing newline", () => {
  const out = serializeJsonl([
    { id: "pm-1", title: "Write docs", status: "open", priority: 1, tags: ["docs"], deadline: "2026-09-01T00:00:00.000Z" },
    { id: "pm-2", title: "Done thing", status: "closed" },
  ]);
  const lines = out.split("\n");
  // two rows + trailing empty string from the final newline
  assert.equal(lines.length, 3);
  assert.equal(lines[2], "");
  const a = JSON.parse(lines[0]);
  assert.equal(a.id, "pm-1");
  assert.equal(a.title, "Write docs");
  assert.equal(a.priority, 1);
  assert.deepEqual(a.tags, ["docs"]);
  assert.equal(a.deadline, "2026-09-01T00:00:00.000Z");
  const b = JSON.parse(lines[1]);
  assert.equal(b.id, "pm-2");
  assert.equal(b.status, "closed");
  assert.equal("priority" in b, false, "absent optional fields are omitted");
});

test("serializeJsonl returns the empty string for no items", () => {
  assert.equal(serializeJsonl([]), "");
});

test("serializeJsonl omits empty arrays/objects but keeps zero/boolean-free fields", () => {
  const out = serializeJsonl([{ id: "pm-3", title: "Bare", status: "open", tags: [] }]);
  const row = JSON.parse(out.trim());
  assert.equal(row.id, "pm-3");
  assert.equal("tags" in row, false, "empty tags array omitted");
});

test("parseJsonl parses rows back into PmItem and defaults status to open", () => {
  const content = JSON.stringify({ id: "pm-1", title: "A", status: "in_progress", priority: 2 }) + "\n" +
    JSON.stringify({ id: "pm-2", title: "B" }) + "\n";
  const items = parseJsonl(content);
  assert.equal(items.length, 2);
  assert.equal(items[0].status, "in_progress");
  assert.equal(items[0].priority, 2);
  assert.equal(items[1].status, "open", "missing status defaults to open");
  assert.equal(items[1].id, "pm-2");
});

test("parseJsonl skips blank lines", () => {
  const content = JSON.stringify({ title: "X" }) + "\n\n   \n" + JSON.stringify({ title: "Y" }) + "\n";
  const items = parseJsonl(content);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "X");
  assert.equal(items[1].title, "Y");
});

test("parseJsonl round-trips populated fields and documents omitted empty arrays", () => {
  const items = [
    { id: "pm-1", title: "Task A", status: "open", priority: 0, tags: ["proj"], deadline: "2026-07-01T00:00:00.000Z" },
    { id: "pm-2", title: "Task B", status: "closed", priority: 2, tags: [] },
  ];
  const txt = serializeJsonl(items);
  const parsed = parseJsonl(txt);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, "pm-1");
  assert.equal(parsed[0].priority, 0);
  assert.deepEqual(parsed[0].tags, ["proj"]);
  assert.equal(parsed[0].deadline, "2026-07-01T00:00:00.000Z");
  assert.equal(parsed[1].status, "closed");
  assert.equal("tags" in parsed[1], false, "empty tags are intentionally omitted");
});

test("parseJsonl normalizes kv values to strings and drops nullish values", () => {
  const [item] = parseJsonl(JSON.stringify({ title: "KV", kv: { count: 2, enabled: true, nested: { x: 1 }, absent: null } }));
  assert.deepEqual(item.kv, { count: "2", enabled: "true", nested: "[object Object]" });
});

test("parseJsonl throws a USAGE error on malformed JSON or missing title", () => {
  assert.throws(() => parseJsonl("{not json\n"), /Invalid jsonl on line 1/);
  assert.throws(() => parseJsonl(JSON.stringify({ id: "x" }) + "\n"), /Missing or empty 'title'/);
  assert.throws(() => parseJsonl("123\n"), /expected a JSON object/);
});

// ---------------------------------------------------------------------------
// --format checkbox: flat checkbox markdown export (import shares the markdown grammar)
// ---------------------------------------------------------------------------

test("renderCheckboxMarkdown emits a flat checkbox list with no header or sections", () => {
  const out = renderCheckboxMarkdown([
    { id: "pm-1", title: "Open task", status: "open", type: "Task" },
    { id: "pm-2", title: "Done task", status: "closed" },
  ]);
  assert.equal(out, "- [ ] Open task <!-- pm-1 -->\n- [x] Done task <!-- pm-2 -->\n");
  assert.ok(!out.includes("# TODO"), "no # TODO header");
  assert.ok(!out.includes("## Open"), "no section headings");
});

test("renderCheckboxMarkdown returns empty string for no items", () => {
  assert.equal(renderCheckboxMarkdown([]), "");
});

test("renderCheckboxMarkdown with metadata includes priority/deadline tokens", () => {
  const out = renderCheckboxMarkdown(
    [{ id: "pm-1", title: "Task", status: "open", priority: 0, deadline: "2026-07-01T00:00:00.000Z" }],
    true,
  );
  assert.ok(out.includes("(p0)"), "number-scheme priority token");
  assert.ok(out.includes("due:2026-07-01"), "due token");
});

test("checkbox export re-parses with the markdown grammar (round-trip)", () => {
  const out = renderCheckboxMarkdown([
    { id: "pm-1", title: "Round trip", status: "open", type: "Feature" },
  ]);
  const parsed = parseMarkdownTodos(out, "stdin");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].text, "Round trip");
  assert.equal(parsed[0].pmId, "pm-1");
  // checkbox is a flat format and intentionally omits the type annotation
  // (only the default markdown export emits it), so the type is not recovered.
  assert.equal(parsed[0].itemType, undefined);
});

// ---------------------------------------------------------------------------
// --priority-map: number (default) vs letter scheme for markdown/tasklist metadata
// ---------------------------------------------------------------------------

test("renderDefaultMarkdown number scheme emits (pN) priority tokens", () => {
  const out = renderDefaultMarkdown(
    [{ id: "pm-1", title: "T", status: "open", priority: 0 }],
    "2026-01-01T00:00:00.000Z",
    true,
    "number",
  );
  assert.ok(out.includes("(p0)"), "number scheme -> (p0)");
  assert.ok(!out.includes("(A)"), "no letter token in number scheme");
});

test("renderDefaultMarkdown letter scheme emits (A)..(E) priority tokens", () => {
  const out = renderDefaultMarkdown(
    [{ id: "pm-1", title: "T", status: "open", priority: 2 }],
    "2026-01-01T00:00:00.000Z",
    true,
    "letter",
  );
  assert.ok(out.includes("(C)"), "letter scheme -> (C) for priority 2");
  assert.ok(!out.includes("(p2)"), "no number token in letter scheme");
});

test("renderTaskList letter scheme emits letter priority tokens", () => {
  const out = renderTaskList(
    [{ id: "pm-1", title: "T", status: "open", priority: 4 }],
    "status",
    true,
    "letter",
  );
  assert.ok(out.includes("(E)"), "priority 4 -> (E)");
});

test("renderGroupedMarkdown letter scheme emits letter priority tokens", () => {
  const out = renderGroupedMarkdown(
    [{ id: "pm-1", title: "T", status: "open", priority: 1, sprint: "S1" }],
    "sprint",
    "2026-01-01T00:00:00.000Z",
    true,
    "letter",
  );
  assert.ok(out.includes("(B)"), "priority 1 -> (B)");
});

test("renderCheckboxMarkdown letter scheme emits letter priority tokens", () => {
  const out = renderCheckboxMarkdown(
    [{ id: "pm-1", title: "T", status: "open", priority: 3 }],
    true,
    "letter",
  );
  assert.ok(out.includes("(D)"), "priority 3 -> (D)");
  assert.ok(!out.includes("(p3)"), "no number token in letter scheme");
});

test("letter priority metadata parses back without remaining in the title", () => {
  const [todo] = parseMarkdownTodos("- [ ] Alpha (B) [Task] <!-- pm-1234 -->\n");
  assert.equal(todo.text, "Alpha");
  assert.equal(todo.priority, 1);
  assert.equal(todo.itemType, "Task");
});

// ---------------------------------------------------------------------------
// --filter status/type: parseFilterExpression
// ---------------------------------------------------------------------------

test("parseFilterExpression returns undefined for empty/absent input", () => {
  assert.equal(parseFilterExpression(undefined), undefined);
  assert.equal(parseFilterExpression(""), undefined);
  assert.equal(parseFilterExpression("   "), undefined);
});

test("parseFilterExpression parses status=value and key:value forms", () => {
  assert.deepEqual(parseFilterExpression("status=open"), { status: "open" });
  assert.deepEqual(parseFilterExpression("type:Task"), { type: "Task" });
});

test("parseFilterExpression parses a comma-separated list and last-wins on repeats", () => {
  assert.deepEqual(parseFilterExpression("status=open,type=Task"), { status: "open", type: "Task" });
  assert.deepEqual(parseFilterExpression("status=open,status=closed"), { status: "closed" });
});

test("parseFilterExpression throws on unknown keys and malformed tokens", () => {
  assert.throws(() => parseFilterExpression("sprint=S1"), /Unknown --filter key 'sprint'/);
  assert.throws(() => parseFilterExpression("status"), /Invalid --filter/);
});

// ---------------------------------------------------------------------------
// validateTodoFile: jsonl + checkbox formats
// ---------------------------------------------------------------------------

test("validateTodoFile flags malformed jsonl lines", () => {
  const content = JSON.stringify({ id: "pm-1", title: "Ok", status: "open" }) + "\n" + "{bad\n";
  const { issues, taskCount } = validateTodoFile(content, "jsonl");
  assert.equal(taskCount, 1);
  assert.ok(issues.some((i) => i.severity === "error" && /Invalid JSON/.test(i.message)));
});

test("validateTodoFile flags jsonl row missing title and out-of-range priority", () => {
  const content = JSON.stringify({ id: "pm-1" }) + "\n" +
    JSON.stringify({ title: "Ok", priority: 9 }) + "\n";
  const { issues } = validateTodoFile(content, "jsonl");
  assert.ok(issues.some((i) => /Missing or empty 'title'/.test(i.message)));
  assert.ok(issues.some((i) => /Invalid priority/.test(i.message)));
});

test("validateTodoFile accepts a clean jsonl file", () => {
  const content = JSON.stringify({ id: "pm-1", title: "Ok", status: "open" }) + "\n" +
    JSON.stringify({ id: "pm-2", title: "Ok2", status: "closed", deadline: "2026-07-01T00:00:00.000Z" }) + "\n";
  const { issues, taskCount } = validateTodoFile(content, "jsonl");
  assert.equal(taskCount, 2);
  assert.equal(issues.filter((i) => i.severity === "error").length, 0);
});

test("validateTodoFile treats checkbox as the markdown grammar", () => {
  const content = "- [ ] Real task\n- [y] bad marker\n";
  const { issues, taskCount } = validateTodoFile(content, "checkbox");
  assert.equal(taskCount, 1);
  assert.ok(issues.some((i) => i.severity === "warning" && /did not parse/.test(i.message)));
});

// ---------------------------------------------------------------------------
// --reverse: applyExportOrder composes with --sort / preserves native order
// ---------------------------------------------------------------------------

const orderSample = [
  { id: "pm-1", title: "Banana", status: "open", priority: 2, deadline: "2026-05-01" },
  { id: "pm-2", title: "apple", status: "open", priority: 0, deadline: "2026-07-01" },
  { id: "pm-3", title: "Cherry", status: "open", deadline: "2026-06-01" }, // no priority
];

test("applyExportOrder without sort/reverse preserves the input order", () => {
  const out = applyExportOrder(orderSample, undefined, undefined);
  assert.deepEqual(out.map((i) => i.id), ["pm-1", "pm-2", "pm-3"]);
});

test("applyExportOrder --reverse flips the native order to oldest-first", () => {
  const out = applyExportOrder(orderSample, undefined, true);
  assert.deepEqual(out.map((i) => i.id), ["pm-3", "pm-2", "pm-1"], "native order reversed");
  assert.notEqual(out, orderSample, "reverse returns a copy, not a mutation");
  // original is untouched
  assert.deepEqual(orderSample.map((i) => i.id), ["pm-1", "pm-2", "pm-3"]);
});

test("applyExportOrder --sort priority then --reverse yields lowest-priority first", () => {
  // sorted by priority asc: pm-2(0), pm-1(2), pm-3(none) → reversed: pm-3, pm-1, pm-2
  const out = applyExportOrder(orderSample, "priority", true);
  assert.deepEqual(out.map((i) => i.id), ["pm-3", "pm-1", "pm-2"]);
});

test("applyExportOrder --sort title then --reverse is descending alphabetical", () => {
  // title asc: apple, Banana, Cherry → reversed: Cherry, Banana, apple
  const out = applyExportOrder(orderSample, "title", true);
  assert.deepEqual(out.map((i) => i.title), ["Cherry", "Banana", "apple"]);
});

test("applyExportOrder --sort without reverse is ascending (composes correctly)", () => {
  const out = applyExportOrder(orderSample, "priority", false);
  assert.deepEqual(out.map((i) => i.id), ["pm-2", "pm-1", "pm-3"]);
});
