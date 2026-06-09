import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  priorityLetterToPm,
  pmPriorityToLetter,
  parseTodoTxtLine,
  parseTodoTxt,
  serializeTodoTxtLine,
  serializeTodoTxt,
  parsePiTodoDetails,
  serializePiTodoDetails,
  extractTodojsonSourceId,
  buildTodojsonImportDescription,
  renderTaskList,
  groupItems,
  validateTodoFile,
  preflightValidateImportFiles,
  renderDefaultMarkdown,
  renderGroupedMarkdown,
  todoTxtItemToPm,
  sortItems,
  extractPmIdComment,
  extractTypeTag,
  resolveUpsertTitleType,
  todoSignatureKey,
  buildExistingTodoIndex,
  extractCreatedTodoId,
  parseMarkdownTodos,
  extractMarkdownDue,
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
// pi coding-agent todo extension JSON state
// ---------------------------------------------------------------------------

test("parsePiTodoDetails parses upstream todo tool result details", () => {
  const details = parsePiTodoDetails(JSON.stringify({
    action: "list",
    todos: [
      { id: 1, text: "Import context", done: false },
      { id: 2, text: "Export context", done: true },
    ],
    nextId: 3,
  }));
  assert.equal(details.action, "list");
  assert.equal(details.nextId, 3);
  assert.deepEqual(details.todos, [
    { id: 1, text: "Import context", done: false },
    { id: 2, text: "Export context", done: true },
  ]);
});

test("parsePiTodoDetails accepts a raw Todo array and computes nextId", () => {
  const details = parsePiTodoDetails(JSON.stringify([
    { id: 4, text: "Standalone todo", done: false },
  ]));
  assert.equal(details.action, "list");
  assert.equal(details.nextId, 5);
  assert.deepEqual(details.todos, [{ id: 4, text: "Standalone todo", done: false }]);
});

test("serializePiTodoDetails emits TodoDetails compatible with upstream todo.ts", () => {
  const out = serializePiTodoDetails([
    { id: "pm-1", title: "Open task", status: "open" },
    { id: "pm-2", title: "Done task", status: "closed" },
  ]);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    action: "list",
    todos: [
      { id: 1, text: "Open task", done: false },
      { id: 2, text: "Done task", done: true },
    ],
    nextId: 3,
  });
});

test("extractTodojsonSourceId reads persisted todo-id markers from descriptions", () => {
  assert.equal(extractTodojsonSourceId("Imported from todo-state.json line 2 (todo-id:17)"), 17);
  assert.equal(extractTodojsonSourceId("Imported from todo-state.json line 2"), undefined);
  assert.equal(extractTodojsonSourceId(undefined), undefined);
});

test("buildTodojsonImportDescription includes a stable todo-id marker when available", () => {
  assert.equal(
    buildTodojsonImportDescription("/tmp/todo-state.json", 3, 42),
    "Imported from /tmp/todo-state.json line 3 (todo-id:42)",
  );
  assert.equal(
    buildTodojsonImportDescription("/tmp/todo-state.json", 3),
    "Imported from /tmp/todo-state.json line 3",
  );
});

test("serializePiTodoDetails preserves persisted todo ids and assigns new ids after max", () => {
  const out = serializePiTodoDetails([
    {
      id: "pm-a",
      title: "Baseline context",
      status: "open",
      description: "Imported from todo-state.json line 1 (todo-id:7)",
      created_at: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "pm-b",
      title: "Close stale item",
      status: "closed",
      description: "Imported from todo-state.json line 2 (todo-id:3)",
      created_at: "2026-06-02T00:00:00.000Z",
    },
    {
      id: "pm-c",
      title: "Release checklist",
      status: "open",
      created_at: "2026-06-03T00:00:00.000Z",
    },
  ]);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.todos, [
    { id: 3, text: "Close stale item", done: true },
    { id: 7, text: "Baseline context", done: false },
    { id: 8, text: "Release checklist", done: false },
  ]);
  assert.equal(parsed.nextId, 9);
});

test("serializePiTodoDetails resolves duplicate persisted ids by keeping first and reassigning later rows", () => {
  const out = serializePiTodoDetails([
    {
      id: "pm-a",
      title: "First owner",
      status: "open",
      description: "Imported from todo-state.json line 1 (todo-id:2)",
      created_at: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "pm-b",
      title: "Duplicate owner",
      status: "open",
      description: "Imported from todo-state.json line 2 (todo-id:2)",
      created_at: "2026-06-02T00:00:00.000Z",
    },
  ]);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.todos, [
    { id: 2, text: "First owner", done: false },
    { id: 3, text: "Duplicate owner", done: false },
  ]);
  assert.equal(parsed.nextId, 4);
});

test("validateTodoFile rejects duplicate todojson ids", () => {
  const { issues, taskCount } = validateTodoFile(JSON.stringify({
    todos: [
      { id: 1, text: "One", done: false },
      { id: 1, text: "Duplicate", done: true },
    ],
    nextId: 2,
  }), "todojson");
  assert.equal(taskCount, 2);
  assert.ok(issues.some((issue) => issue.severity === "error" && /Duplicate todo id/.test(issue.message)));
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

test("markdown metadata is opt-in and round-trips priority/deadline tokens", () => {
  const items = [
    { id: "pm-a", title: "Open task", status: "open", type: "Task", priority: 1, deadline: "2026-07-01T00:00:00.000Z" },
  ];
  const plain = renderDefaultMarkdown(items, "2026-06-02T00:00:00.000Z");
  assert.equal(plain.includes("(p1)"), false);
  assert.equal(plain.includes("due:2026-07-01"), false);

  const out = renderDefaultMarkdown(items, "2026-06-02T00:00:00.000Z", true);
  assert.match(out, /Open task \(p1\) due:2026-07-01 \[Task\] <!-- pm-a -->/);
  const parsed = parseMarkdownTodos(out);
  assert.equal(parsed[0].text, "Open task");
  assert.equal(parsed[0].priority, 1);
  assert.equal(parsed[0].deadline, "2026-07-01");
  assert.equal(parsed[0].itemType, "Task");
});

test("extractMarkdownDue strips only parseable due tokens", () => {
  assert.deepEqual(extractMarkdownDue("Ship it due:2026-08-09 now"), {
    text: "Ship it now",
    deadline: "2026-08-09",
  });
  assert.deepEqual(extractMarkdownDue("Ship it due:soon"), { text: "Ship it due:soon" });
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

test("validateTodoFile flags malformed markdown due metadata", () => {
  const { issues } = validateTodoFile("- [ ] ship due:2026-13-99", "markdown");
  assert.ok(issues.some((i) => i.severity === "error" && /Invalid due date/.test(i.message)));
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

// ---------------------------------------------------------------------------
// todo.txt date round-trip (lossless on creation/completion dates)
// ---------------------------------------------------------------------------

test("serializeTodoTxtLine emits a creation date for an open item", () => {
  const line = serializeTodoTxtLine({
    id: "", title: "Write docs", status: "open", priority: 1,
    tags: ["docs"], creationDate: "2026-01-01",
  });
  assert.equal(line, "(B) 2026-01-01 Write docs +docs");
});

test("serializeTodoTxtLine emits completion + creation dates for a done item", () => {
  const line = serializeTodoTxtLine({
    id: "", title: "Buy milk", status: "closed",
    tags: ["groceries"], creationDate: "2026-01-01", completionDate: "2026-01-02",
  });
  assert.equal(line, "x 2026-01-02 2026-01-01 Buy milk +groceries");
});

test("todo.txt creation+completion dates survive a parse -> toPm -> serialize round-trip", () => {
  // The canonical lossy case called out in the bug report: dates used to be
  // PARSED but DROPPED on re-serialization. (projects/contexts both fold to
  // pm tags by existing design, so this case uses only a +project.)
  const original = "x 2026-01-02 2026-01-01 Buy milk +groceries due:2026-02-01";
  const parsed = parseTodoTxtLine(original);
  assert.ok(parsed);
  assert.equal(parsed!.completionDate, "2026-01-02");
  assert.equal(parsed!.creationDate, "2026-01-01");

  const roundTripped = serializeTodoTxtLine(todoTxtItemToPm(parsed!));
  assert.equal(roundTripped, original);
});

test("open-item creation date + priority round-trips losslessly", () => {
  const original = "(A) 2026-03-15 Plan sprint +work due:2026-04-01";
  const parsed = parseTodoTxtLine(original);
  assert.ok(parsed);
  const roundTripped = serializeTodoTxtLine(todoTxtItemToPm(parsed!));
  assert.equal(roundTripped, original);
});

// ---------------------------------------------------------------------------
// todo.txt key:value passthrough
// ---------------------------------------------------------------------------

test("arbitrary key:value pairs survive a round-trip", () => {
  const original = "Ship release id:gh-123 rec:1w due:2026-08-01";
  const parsed = parseTodoTxtLine(original);
  assert.ok(parsed);
  assert.equal(parsed!.kv["id"], "gh-123");
  assert.equal(parsed!.kv["rec"], "1w");

  const line = serializeTodoTxtLine(todoTxtItemToPm(parsed!));
  // kv is emitted sorted; due comes from the deadline slot which precedes kv.
  assert.equal(line, "Ship release due:2026-08-01 id:gh-123 rec:1w");
  // And it re-parses identically (round-trip stable).
  const reparsed = parseTodoTxtLine(line);
  assert.equal(reparsed!.kv["id"], "gh-123");
  assert.equal(reparsed!.kv["rec"], "1w");
  assert.equal(reparsed!.due, "2026-08-01");
});

test("serializeTodoTxtLine omits date/kv fields when absent (back-compat)", () => {
  // Items with no creation/completion/kv fields serialize exactly as before.
  const open = serializeTodoTxtLine({ id: "pm-1", title: "Write docs", status: "open", priority: 1, tags: ["docs"], deadline: "2026-09-01T00:00:00.000Z" });
  assert.equal(open, "(B) Write docs +docs due:2026-09-01");
  const done = serializeTodoTxtLine({ id: "pm-2", title: "Done thing", status: "closed", priority: 0, tags: [] });
  assert.equal(done, "x Done thing");
});

// ---------------------------------------------------------------------------
// Export sort
// ---------------------------------------------------------------------------

const sortSample = [
  { id: "pm-1", title: "Banana", status: "open", priority: 2, deadline: "2026-05-01" },
  { id: "pm-2", title: "apple", status: "open", priority: 0, deadline: "2026-07-01" },
  { id: "pm-3", title: "Cherry", status: "open", deadline: "2026-06-01" }, // no priority
];

test("sortItems by priority puts highest (0) first, missing last", () => {
  const out = sortItems(sortSample, "priority");
  assert.deepEqual(out.map((i) => i.id), ["pm-2", "pm-1", "pm-3"]);
});

test("sortItems by deadline orders ascending", () => {
  const out = sortItems(sortSample, "deadline");
  assert.deepEqual(out.map((i) => i.id), ["pm-1", "pm-3", "pm-2"]);
});

test("sortItems by title is case-insensitive alphabetical", () => {
  const out = sortItems(sortSample, "title");
  assert.deepEqual(out.map((i) => i.title), ["apple", "Banana", "Cherry"]);
});

test("sortItems with no key returns input unchanged (and does not mutate)", () => {
  const input = [...sortSample];
  const out = sortItems(input, undefined);
  assert.equal(out, input);
  // sorting returns a copy, original order preserved
  const copy = sortItems(input, "title");
  assert.notEqual(copy, input);
  assert.deepEqual(input.map((i) => i.id), ["pm-1", "pm-2", "pm-3"]);
});

// ---------------------------------------------------------------------------
// Default markdown export is byte-identical regardless of new fields
// ---------------------------------------------------------------------------

test("default markdown export is byte-identical to the frozen contract", () => {
  // Same items the historical test uses, plus the new optional fields populated
  // to prove they NEVER leak into the default markdown export.
  const items = [
    { id: "pm-a", title: "Open task", status: "open", type: "Task", sprint: "S1", creationDate: "2026-01-01", kv: { rec: "1w" } },
    { id: "pm-b", title: "In progress", status: "in_progress", type: "Bug", sprint: "S2" },
    { id: "pm-c", title: "Closed task", status: "closed", type: "Task", sprint: "S1", completionDate: "2026-01-02" },
  ];
  const out = renderDefaultMarkdown(items, "2026-06-02T00:00:00.000Z");
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

// ---------------------------------------------------------------------------
// Import preflight (fail-fast syntax gate)
// ---------------------------------------------------------------------------

test("preflightValidateImportFiles throws on a malformed todo.txt (structural error)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pmtodos-pf-"));
  const file = join(dir, "bad.txt");
  writeFileSync(file, "Task due:2026-13-99\n", "utf-8");
  assert.throws(
    () => preflightValidateImportFiles([file], "todotxt"),
    (err: any) => {
      assert.match(err.message, /Preflight: 1 structural error/);
      assert.match(err.message, /Invalid due date/);
      assert.equal(err.exitCode, 1);
      return true;
    },
  );
});

test("preflightValidateImportFiles passes silently on a clean todo.txt", () => {
  const dir = mkdtempSync(join(tmpdir(), "pmtodos-pf-"));
  const file = join(dir, "good.txt");
  writeFileSync(file, "(A) Real task +proj due:2026-07-01\nx Done\n", "utf-8");
  assert.doesNotThrow(() => preflightValidateImportFiles([file], "todotxt"));
});

test("preflightValidateImportFiles throws NOT_FOUND on an unreadable file", () => {
  assert.throws(
    () => preflightValidateImportFiles(["/no/such/file-xyz.txt"], "markdown"),
    (err: any) => {
      assert.match(err.message, /Preflight: cannot read/);
      assert.equal(err.exitCode, 3);
      return true;
    },
  );
});

test("preflightValidateImportFiles does NOT throw on markdown warnings (lenient)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pmtodos-pf-"));
  const file = join(dir, "warn.md");
  // `- [y]` is a warning (resembles a checkbox, doesn't parse), not a fatal error.
  writeFileSync(file, "- [y] busted marker\n- [ ] fine\n", "utf-8");
  assert.doesNotThrow(() => preflightValidateImportFiles([file], "markdown"));
});

test("preflightValidateImportFiles aborts before later files when an earlier file is bad", () => {
  const dir = mkdtempSync(join(tmpdir(), "pmtodos-pf-"));
  const bad = join(dir, "a-bad.md");
  const good = join(dir, "b-good.md");
  writeFileSync(bad, "- [ ] (p9) out of range priority\n", "utf-8");
  writeFileSync(good, "- [ ] fine\n", "utf-8");
  assert.throws(
    () => preflightValidateImportFiles([bad, good], "markdown"),
    /a-bad\.md/,
  );
});

// ---------------------------------------------------------------------------
// Round-trip id preservation: <!-- pm-id --> comment parsing
// ---------------------------------------------------------------------------

test("extractPmIdComment captures the id and strips the comment from the title", () => {
  const r = extractPmIdComment("Open task <!-- pm-abc123 -->");
  assert.equal(r.text, "Open task");
  assert.equal(r.id, "pm-abc123");
});

test("extractPmIdComment leaves text without a comment untouched (default-path stability)", () => {
  const r = extractPmIdComment("Just a plain task");
  assert.equal(r.text, "Just a plain task");
  assert.equal(r.id, undefined);
});

test("extractPmIdComment only consumes a TRAILING comment, not mid-line text", () => {
  // A comment that is not at end-of-line is left in place (no id captured).
  const r = extractPmIdComment("task <!-- not-trailing --> more words");
  assert.equal(r.id, undefined);
  assert.equal(r.text, "task <!-- not-trailing --> more words");
});

test("extractPmIdComment ignores an empty comment (no id, line left untouched)", () => {
  // An empty `<!--  -->` is not a pm-id marker, so we capture no id and leave
  // the text exactly as written rather than risk mangling a hand-edited line.
  const r = extractPmIdComment("task <!--  -->");
  assert.equal(r.id, undefined);
  assert.equal(r.text, "task <!--  -->");
});

test("parseMarkdownTodos strips the pm-id comment and records pmId (round-trip)", () => {
  // The shape the exporter emits: `- [ ] Title [Type] <!-- id -->`. Re-parsing
  // must NOT fold the comment into the title (the latent round-trip bug) and
  // must capture the id for --upsert keying.
  const md = "## Open\n\n- [ ] Open task <!-- pm-a -->\n- [x] Done task <!-- pm-b -->\n";
  const todos = parseMarkdownTodos(md);
  assert.equal(todos.length, 2);
  assert.equal(todos[0].text, "Open task");
  assert.equal(todos[0].pmId, "pm-a");
  assert.equal(todos[0].checked, false);
  assert.equal(todos[1].text, "Done task");
  assert.equal(todos[1].pmId, "pm-b");
  assert.equal(todos[1].checked, true);
});

test("parseMarkdownTodos strips the pm-id comment AND a priority marker together", () => {
  const todos = parseMarkdownTodos("- [ ] Ship it (p1) <!-- pm-z -->\n");
  assert.equal(todos.length, 1);
  assert.equal(todos[0].text, "Ship it");
  assert.equal(todos[0].priority, 1);
  assert.equal(todos[0].pmId, "pm-z");
});

test("parseMarkdownTodos leaves pmId undefined for a hand-written line", () => {
  const todos = parseMarkdownTodos("- [ ] hand written task\n");
  assert.equal(todos[0].text, "hand written task");
  assert.equal(todos[0].pmId, undefined);
});

// ---------------------------------------------------------------------------
// Type-tag round-trip (export emits ` [Type]`; import must parse it back)
// ---------------------------------------------------------------------------

test("extractTypeTag captures a trailing [Type] tag and strips it from the title", () => {
  const r = extractTypeTag("Build dashboard [Feature]");
  assert.equal(r.text, "Build dashboard");
  assert.equal(r.type, "Feature");
});

test("extractTypeTag leaves text without a trailing tag untouched", () => {
  const r = extractTypeTag("Just a plain task");
  assert.equal(r.text, "Just a plain task");
  assert.equal(r.type, undefined);
});

test("extractTypeTag only consumes the LAST trailing bracket group", () => {
  // A title that itself ends in "[staging]" keeps that bracket; only the
  // appended Title-Case type tag is shed.
  const r = extractTypeTag("Deploy [staging] [Task]");
  assert.equal(r.text, "Deploy [staging]");
  assert.equal(r.type, "Task");
});

test("extractTypeTag matches Title-Case pm types but NOT all-caps/lowercase technical tags", () => {
  for (const t of ["Feature", "Issue", "Task", "Epic", "Chore", "Milestone", "Decision"]) {
    assert.equal(extractTypeTag(`Title [${t}]`).type, t, `should strip [${t}]`);
  }
  // ALL-CAPS acronyms and lowercase tags are NOT types → left in the title.
  for (const tag of ["WIP", "CI", "PR", "staging", "prod", "x"]) {
    const r = extractTypeTag(`Title [${tag}]`);
    assert.equal(r.type, undefined, `should NOT strip [${tag}]`);
    assert.equal(r.text, `Title [${tag}]`);
  }
});

test("parseMarkdownTodos round-trips the exporter shape: title clean + type recovered", () => {
  // Exactly what renderDefaultMarkdown emits for an open item.
  const md = "## Open\n\n- [ ] Build dashboard [Feature] <!-- pm-a -->\n";
  const todos = parseMarkdownTodos(md);
  assert.equal(todos.length, 1);
  assert.equal(todos[0].text, "Build dashboard"); // tag NOT folded into the title
  assert.equal(todos[0].itemType, "Feature"); // type recovered for --type
  assert.equal(todos[0].pmId, "pm-a");
});

test("parseMarkdownTodos recovers type AND priority AND id together", () => {
  // The exporter emits canonical types (the `bug` alias is normalized to
  // `Issue`), so the round-trip tag is `[Issue]`, not `[Bug]`.
  const todos = parseMarkdownTodos("- [ ] Ship it (p1) [Issue] <!-- pm-z -->\n");
  assert.equal(todos[0].text, "Ship it");
  assert.equal(todos[0].priority, 1);
  assert.equal(todos[0].itemType, "Issue");
  assert.equal(todos[0].pmId, "pm-z");
});

test("parseMarkdownTodos does NOT strip a [bracket] from a hand-written line (no pm-id)", () => {
  // Without a provenance comment the trailing bracket is real title content and
  // must be preserved — keeps the default (non-round-trip) path byte-stable.
  const todos = parseMarkdownTodos("- [ ] Refactor [legacy] module\n- [ ] Title ends in [WIP]\n");
  assert.equal(todos[0].text, "Refactor [legacy] module");
  assert.equal(todos[0].itemType, undefined);
  assert.equal(todos[1].text, "Title ends in [WIP]");
  assert.equal(todos[1].itemType, undefined);
});

test("parseMarkdownTodos preserves a real trailing bracket in the title even WITH a pm-id (only type tag shed)", () => {
  const todos = parseMarkdownTodos("- [ ] Deploy [staging] [Task] <!-- pm-q -->\n");
  assert.equal(todos[0].text, "Deploy [staging]");
  assert.equal(todos[0].itemType, "Task");
  assert.equal(todos[0].pmId, "pm-q");
});

test("a free-form trailing <!-- comment --> is NOT treated as provenance (no bogus pmId, no type-tag stripping)", () => {
  // Regression guard: a hand-written note must not set a bogus pmId, which would
  // (a) let --upsert match a phantom id and (b) trip the type-tag gate and strip
  // a legitimate trailing `[WIP]`. The non-id comment + tag stay in the title.
  const todos = parseMarkdownTodos("- [ ] Polish UI [WIP] <!-- note -->\n- [ ] Review <!-- see figure 1 -->\n");
  assert.equal(todos[0].pmId, undefined);
  assert.equal(todos[0].itemType, undefined);
  assert.equal(todos[0].text, "Polish UI [WIP] <!-- note -->");
  assert.equal(todos[1].pmId, undefined);
  assert.equal(todos[1].text, "Review <!-- see figure 1 -->");
});

test("parseMarkdownTodos: a CHECKED item whose title ends in a non-type bracket is NOT stripped", () => {
  // gemini-code-assist (high): a closed/checked item whose title naturally ends
  // in a capitalized bracket that is NOT a pm type (`Support [Safari]`,
  // `Fix [Firefox]`) must keep that bracket. The exact-vocabulary regex
  // guarantees this regardless of the checkbox state.
  const todos = parseMarkdownTodos("## Done\n\n- [x] Support [Safari] <!-- pm-1 -->\n- [x] Fix [Firefox] <!-- pm-2 -->\n");
  assert.equal(todos[0].checked, true);
  assert.equal(todos[0].itemType, undefined);
  assert.equal(todos[0].text, "Support [Safari]");
  assert.equal(todos[1].itemType, undefined);
  assert.equal(todos[1].text, "Fix [Firefox]");
});

test("parseMarkdownTodos: ticking off an exported open item still recognises its type tag (check-off workflow)", () => {
  // gemini-code-assist (critical): the common round-trip is export → tick a box
  // in the editor → re-import to close it. The line is still `Task [Feature]`
  // with the open-export tag, just `[x]` now. `[Feature]` must be parsed as the
  // type, not folded into the title.
  const todos = parseMarkdownTodos("- [x] Implement login [Feature] <!-- pm-3 -->\n");
  assert.equal(todos[0].checked, true);
  assert.equal(todos[0].text, "Implement login");
  assert.equal(todos[0].itemType, "Feature");
  assert.equal(todos[0].pmId, "pm-3");
});

test("parseMarkdownTodos: an item titled with a [Bracket] keeps it; only the appended type tag is shed", () => {
  // `Deploy to [Staging]` of type Task exports as `… [Staging] [Task] <!-- id -->`.
  const todos = parseMarkdownTodos("- [ ] Deploy to [Staging] [Task] <!-- pm-4 -->\n");
  assert.equal(todos[0].text, "Deploy to [Staging]");
  assert.equal(todos[0].itemType, "Task");
});

test("extractTypeTag matches only the fixed pm type set, not arbitrary Title-Case words", () => {
  assert.equal(extractTypeTag("x [Feature]").type, "Feature");
  // Title-Case words that are NOT pm types are left in place.
  for (const w of ["Safari", "Staging", "Firefox", "Chrome", "Done"]) {
    const r = extractTypeTag(`x [${w}]`);
    assert.equal(r.type, undefined, `should NOT strip [${w}]`);
    assert.equal(r.text, `x [${w}]`);
  }
});

test("parseMarkdownTodos: a hyphenated trailing comment + a technical [tag] does not corrupt the title", () => {
  // gemini-code-assist edge: `<!-- todo-note -->` matches the hyphenated id
  // grammar (so pmId is set), but `[WIP]` is not a Title-Case pm type, so the
  // type-tag gate must NOT strip it. Title + tag stay intact; itemType stays
  // unset (a phantom pmId that matches no real item is harmless to --upsert).
  const todos = parseMarkdownTodos("- [ ] Polish UI [WIP] <!-- todo-note -->\n");
  assert.equal(todos[0].pmId, "todo-note");
  assert.equal(todos[0].itemType, undefined);
  assert.equal(todos[0].text, "Polish UI [WIP]");
});

test("extractPmIdComment accepts multi-segment ids (custom prefixes) but rejects bare words", () => {
  assert.equal(extractPmIdComment("x <!-- pm-todos-982k -->").id, "pm-todos-982k");
  assert.equal(extractPmIdComment("x <!-- bug-3f2a -->").id, "bug-3f2a");
  // A single bare word (no hyphen) is not an id grammar — left untouched.
  const r = extractPmIdComment("x <!-- note -->");
  assert.equal(r.id, undefined);
  assert.equal(r.text, "x <!-- note -->");
});

// ---------------------------------------------------------------------------
// Upsert keying + index
// ---------------------------------------------------------------------------

test("todoSignatureKey is case/whitespace-insensitive and section-aware", () => {
  assert.equal(todoSignatureKey("Buy   Milk"), todoSignatureKey("buy milk"));
  // Section slug participates in the key.
  assert.notEqual(todoSignatureKey("task", "Backlog"), todoSignatureKey("task", "Done"));
  assert.equal(todoSignatureKey("task", "In Progress"), todoSignatureKey("task", "in-progress"));
  assert.equal(todoSignatureKey("   "), undefined); // empty title → no key
});

test("resolveUpsertTitleType: a real type tag is applied (stored title differs from the line)", () => {
  // Open item `Implement login` (type Feature) exported+ticked → `Implement login [Feature]`.
  const r = resolveUpsertTitleType("Implement login", "Feature", "Implement login");
  assert.equal(r.title, "Implement login");
  assert.equal(r.type, "Feature");
});

test("resolveUpsertTitleType: a title that merely ends in a type bracket is preserved (no retype)", () => {
  // Closed `Complete [Task]` exported WITHOUT a tag → parsed text "Complete" + type "Task".
  const r = resolveUpsertTitleType("Complete", "Task", "Complete [Task]");
  assert.equal(r.title, "Complete [Task]");
  assert.equal(r.type, undefined);
});

test("resolveUpsertTitleType: whitespace in the stored title is normalised for the match and restored verbatim", () => {
  // CodeRabbit: the parser collapses runs of whitespace in the parsed text, so
  // the comparison must normalise the stored title — but the raw title (with its
  // original double space) is what gets restored.
  const r = resolveUpsertTitleType("Complete", "Task", "Complete   [Task]");
  assert.equal(r.title, "Complete   [Task]"); // raw spacing preserved
  assert.equal(r.type, undefined);
});

test("resolveUpsertTitleType: no type, or no existing title, passes through unchanged", () => {
  assert.deepEqual(resolveUpsertTitleType("Plain title", undefined, "Plain title"), {
    title: "Plain title",
    type: undefined,
  });
  assert.deepEqual(resolveUpsertTitleType("New thing", "Bug", undefined), {
    title: "New thing",
    type: "Bug",
  });
});

test("buildExistingTodoIndex records the stored title (for type-tag disambiguation)", () => {
  // gemini-code-assist (high): the upsert UPDATE path uses the matched item's
  // stored title to tell a real round-trip type tag from a title that merely
  // ends in a type-name bracket (e.g. a closed `Complete [Task]`). The index
  // must therefore carry the title.
  const { byId } = buildExistingTodoIndex([
    { id: "pm-1", title: "Complete [Task]", status: "closed" },
  ]);
  assert.equal(byId.get("pm-1")!.title, "Complete [Task]");
});

test("buildExistingTodoIndex keys by id and by title signature (oldest wins on sig)", () => {
  const items = [
    { id: "pm-1", title: "Write docs", status: "open" },
    { id: "pm-2", title: "Write docs", status: "closed" }, // dup title, later → ignored in bySig
    { id: "pm-3", title: "Ship it", status: "open" },
  ];
  const { byId, bySig } = buildExistingTodoIndex(items);
  assert.equal(byId.get("pm-1")!.pmId, "pm-1");
  assert.equal(byId.get("pm-2")!.status, "closed");
  // Signature lookup matches the FIRST (oldest) item with that title.
  assert.equal(bySig.get(todoSignatureKey("write docs")!)!.pmId, "pm-1");
  assert.equal(bySig.get(todoSignatureKey("ship it")!)!.pmId, "pm-3");
});

test("extractCreatedTodoId reads the id out of pm --json create output (several shapes)", () => {
  assert.equal(extractCreatedTodoId('{"id":"pm-9"}'), "pm-9");
  assert.equal(extractCreatedTodoId('{"item":{"id":"pm-10"}}'), "pm-10");
  assert.equal(extractCreatedTodoId('{"result":{"id":"pm-11"}}'), "pm-11");
  assert.equal(extractCreatedTodoId("not json"), undefined);
});
