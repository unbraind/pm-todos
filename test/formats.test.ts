import assert from "node:assert/strict";
import test from "node:test";

import {
  priorityLetterToPm,
  pmPriorityToLetter,
  parseTodoTxtLine,
  parseTodoTxt,
  serializeTodoTxtLine,
  serializeTodoTxt,
  renderTaskList,
  groupItems,
  validateTodoFile,
  renderDefaultMarkdown,
  renderGroupedMarkdown,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Priority letter <-> pm number mapping
// ---------------------------------------------------------------------------

test("priorityLetterToPm maps A..E to 0..4 and clamps F..Z to 4", () => {
  assert.equal(priorityLetterToPm("A"), 0);
  assert.equal(priorityLetterToPm("B"), 1);
  assert.equal(priorityLetterToPm("E"), 4);
  assert.equal(priorityLetterToPm("F"), 4);
  assert.equal(priorityLetterToPm("Z"), 4);
  assert.equal(priorityLetterToPm("a"), 0); // case-insensitive
  assert.equal(priorityLetterToPm(undefined), undefined);
  assert.equal(priorityLetterToPm("1"), undefined); // not a letter
});

test("pmPriorityToLetter maps 0..4 to A..E and clamps out-of-range", () => {
  assert.equal(pmPriorityToLetter(0), "A");
  assert.equal(pmPriorityToLetter(2), "C");
  assert.equal(pmPriorityToLetter(4), "E");
  assert.equal(pmPriorityToLetter(7), "E"); // clamp high
  assert.equal(pmPriorityToLetter(-1), "A"); // clamp low
  assert.equal(pmPriorityToLetter(undefined), undefined);
});

// ---------------------------------------------------------------------------
// todo.txt parsing
// ---------------------------------------------------------------------------

test("parseTodoTxtLine parses a full line", () => {
  const item = parseTodoTxtLine("(A) Call Mom +family @phone due:2026-07-01");
  assert.ok(item);
  assert.equal(item!.done, false);
  assert.equal(item!.priorityLetter, "A");
  assert.equal(item!.text, "Call Mom");
  assert.deepEqual(item!.projects, ["family"]);
  assert.deepEqual(item!.contexts, ["phone"]);
  assert.equal(item!.due, "2026-07-01");
});

test("parseTodoTxtLine handles done marker + completion date", () => {
  const item = parseTodoTxtLine("x 2026-06-01 Buy milk +groceries");
  assert.ok(item);
  assert.equal(item!.done, true);
  assert.equal(item!.completionDate, "2026-06-01");
  assert.equal(item!.text, "Buy milk");
  assert.deepEqual(item!.projects, ["groceries"]);
});

test("parseTodoTxtLine preserves arbitrary key:value pairs", () => {
  const item = parseTodoTxtLine("Ship release rec:1w due:2026-08-01");
  assert.ok(item);
  assert.equal(item!.due, "2026-08-01");
  assert.equal(item!.kv["rec"], "1w");
  assert.equal(item!.text, "Ship release");
});

test("parseTodoTxtLine returns null for blank lines", () => {
  assert.equal(parseTodoTxtLine("   "), null);
  assert.equal(parseTodoTxtLine(""), null);
});

test("parseTodoTxt skips blank lines and parses multiple", () => {
  const items = parseTodoTxt("(B) one\n\n  \nx two\n");
  assert.equal(items.length, 2);
  assert.equal(items[0].priorityLetter, "B");
  assert.equal(items[1].done, true);
});

// ---------------------------------------------------------------------------
// todo.txt serialization
// ---------------------------------------------------------------------------

test("serializeTodoTxtLine emits priority, projects, due for open item", () => {
  const line = serializeTodoTxtLine({
    id: "pm-1", title: "Write docs", status: "open", priority: 1,
    tags: ["docs"], deadline: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(line, "(B) Write docs +docs due:2026-09-01");
});

test("serializeTodoTxtLine marks done items with x and omits priority", () => {
  const line = serializeTodoTxtLine({
    id: "pm-2", title: "Done thing", status: "closed", priority: 0, tags: [],
  });
  assert.equal(line, "x Done thing");
});

test("serializeTodoTxt round-trips through parseTodoTxt (lossless on mapped fields)", () => {
  const items = [
    { id: "pm-1", title: "Task A", status: "open", priority: 0, tags: ["proj"], deadline: "2026-07-01T00:00:00.000Z" },
    { id: "pm-2", title: "Task B", status: "closed", priority: 2, tags: [] },
  ];
  const txt = serializeTodoTxt(items);
  const parsed = parseTodoTxt(txt);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].text, "Task A");
  assert.equal(priorityLetterToPm(parsed[0].priorityLetter), 0);
  assert.deepEqual(parsed[0].projects, ["proj"]);
  assert.equal(parsed[0].due, "2026-07-01");
  assert.equal(parsed[1].done, true);
  assert.equal(parsed[1].text, "Task B");
});

test("serializeTodoTxt returns empty string for no items", () => {
  assert.equal(serializeTodoTxt([]), "");
});

// ---------------------------------------------------------------------------
// Grouping + task-list rendering
// ---------------------------------------------------------------------------

const sampleItems = [
  { id: "pm-a", title: "Open task", status: "open", type: "Task", sprint: "S1" },
  { id: "pm-b", title: "In progress", status: "in_progress", type: "Bug", sprint: "S2" },
  { id: "pm-c", title: "Closed task", status: "closed", type: "Task", sprint: "S1" },
];

test("groupItems by status splits open vs done", () => {
  const groups = groupItems(sampleItems, "status");
  assert.equal(groups.length, 2);
  assert.equal(groups[0].heading, "Open");
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[1].heading, "Done");
  assert.equal(groups[1].items.length, 1);
});

test("groupItems by sprint buckets by field value", () => {
  const groups = groupItems(sampleItems, "sprint");
  const headings = groups.map((g) => g.heading);
  assert.deepEqual(headings, ["S1", "S2"]);
});

test("groupItems sorts (unassigned) last", () => {
  const items = [
    { id: "pm-1", title: "no sprint", status: "open" },
    { id: "pm-2", title: "has sprint", status: "open", sprint: "S1" },
  ];
  const groups = groupItems(items, "sprint");
  assert.deepEqual(groups.map((g) => g.heading), ["S1", "(unassigned)"]);
});

test("renderTaskList produces GFM checkboxes grouped by status", () => {
  const out = renderTaskList(sampleItems, "status");
  assert.match(out, /## Open/);
  assert.match(out, /- \[ \] Open task <!-- pm-a -->/);
  assert.match(out, /- \[x\] Closed task <!-- pm-c -->/);
  assert.match(out, /## Done/);
});

test("renderTaskList can group by type", () => {
  const out = renderTaskList(sampleItems, "type");
  assert.match(out, /## Bug/);
  assert.match(out, /## Task/);
});

// ---------------------------------------------------------------------------
// Default markdown (byte-stability of the historical format)
// ---------------------------------------------------------------------------

test("renderDefaultMarkdown matches the historical layout exactly", () => {
  const out = renderDefaultMarkdown(sampleItems, "2026-06-02T00:00:00.000Z");
  const expected = [
    "# TODO",
    "",
    "<!-- Exported from pm-cli on 2026-06-02T00:00:00.000Z -->",
    "",
    "## Open",
    "",
    "- [ ] Open task [Task] <!-- pm-a -->",
    "- [ ] In progress [Bug] <!-- pm-b -->",
    "",
    "## Done",
    "",
    "- [x] Closed task <!-- pm-c -->",
    "",
  ].join("\n");
  assert.equal(out, expected);
});

test("renderGroupedMarkdown sections by the requested field", () => {
  const out = renderGroupedMarkdown(sampleItems, "sprint", "2026-06-02T00:00:00.000Z");
  assert.match(out, /## S1/);
  assert.match(out, /## S2/);
  assert.match(out, /- \[ \] Open task <!-- pm-a -->/);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validateTodoFile flags a bad due date in todo.txt", () => {
  const { issues, taskCount } = validateTodoFile("Task due:2026-13-99", "todotxt");
  assert.equal(taskCount, 1);
  const errors = issues.filter((i) => i.severity === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Invalid due date/);
});

test("validateTodoFile accepts a clean todo.txt file (no errors)", () => {
  const { issues } = validateTodoFile("(A) Clean task +proj due:2026-07-01\nx Done", "todotxt");
  assert.equal(issues.filter((i) => i.severity === "error").length, 0);
});

test("validateTodoFile warns on malformed markdown checkbox", () => {
  const { issues } = validateTodoFile("- [y] busted marker\n- [ ] fine", "markdown");
  const warnings = issues.filter((i) => i.severity === "warning");
  assert.ok(warnings.some((w) => /did not parse/.test(w.message)));
});

test("validateTodoFile flags an out-of-range (pN) markdown priority marker", () => {
  const { issues } = validateTodoFile("- [ ] big (p9) task", "markdown");
  const errors = issues.filter((i) => i.severity === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /out of range/);
});

test("validateTodoFile warns when no tasks exist in markdown", () => {
  const { issues, taskCount } = validateTodoFile("just prose here", "markdown");
  assert.equal(taskCount, 0);
  assert.ok(issues.some((i) => /No checkbox tasks/.test(i.message)));
});

test("validateTodoFile warns on empty todo.txt task text", () => {
  const { issues } = validateTodoFile("+proj @ctx due:2026-07-01", "todotxt");
  assert.ok(issues.some((i) => /no description text/.test(i.message)));
});
