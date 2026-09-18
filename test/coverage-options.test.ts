/**
 * Direct branch coverage for the internal option readers and small pure helpers
 * that are unreachable through the public extension surface without spawning a
 * full pm subprocess (which contributes no V8 coverage to the test runner).
 *
 * Each function is exercised branch-for-branch: every format alias, every error
 * guard, and every fallback path. The functions were widened from internal to
 * exported solely so these tests can call them directly; they are not part of
 * the package's public API and carry no stability contract beyond the
 * behavioural assertions pinned here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  readBoolOption,
  readStringOption,
  readImportFormat,
  readExportFormat,
  parseFilterExpression,
  readGroupBy,
  readSort,
  readPriorityMap,
  readExportFilter,
  readBoundedIntOption,
  extractPriority,
  filterBySection,
  mapStatusToPm,
  mapPmStatusToChecked,
  sectionToTag,
  shouldRefreshTodojsonDescription,
  parseTimestamp,
  globToRegExp,
  parseFileToNormalized,
  pmJsonMaxBuffer,
  describePmReadFailure,
  runPmCommand,
  parseMarkdownTodos,
  parsePiTodoDetails,
  parseJsonl,
  serializeJsonl,
  serializeTodoTxtLine,
  serializePiTodoDetails,
  extractTodojsonSourceId,
  extractTrailing,
  buildTodojsonImportDescription,
  buildExistingTodoIndex,
  groupItems,
  renderDefaultMarkdown,
  sortItems,
  sortItemsForContext,
  buildTodoContextSnapshot,
  validateTodoFile,
  preflightValidateImportFiles,
  resolveGlob,
  readCompletePmItems,
  runTodoImport,
} from "../index.ts";

// ---------------------------------------------------------------------------
// readBoolOption
// ---------------------------------------------------------------------------

test("readBoolOption returns true for truthy kebab and camelCase keys", () => {
  assert.equal(readBoolOption({ "dry-run": true }, "dry-run", "dryRun"), true);
  assert.equal(readBoolOption({ dryRun: 1 }, "dry-run", "dryRun"), true);
  assert.equal(readBoolOption({ "dry-run": "yes" }, "dry-run", "dryRun"), true);
});

test("readBoolOption returns false for absent, falsy, or zero values", () => {
  assert.equal(readBoolOption({}, "dry-run", "dryRun"), false);
  assert.equal(readBoolOption({ "dry-run": false }, "dry-run", "dryRun"), false);
  assert.equal(readBoolOption({ "dry-run": 0 }, "dry-run", "dryRun"), false);
  assert.equal(readBoolOption({ "dry-run": "" }, "dry-run", "dryRun"), false);
  assert.equal(readBoolOption({ "dry-run": null }, "dry-run", "dryRun"), false);
});

// ---------------------------------------------------------------------------
// readStringOption
// ---------------------------------------------------------------------------

test("readStringOption returns the first defined string among keys", () => {
  assert.equal(readStringOption({ format: "jsonl" }, "format"), "jsonl");
  assert.equal(readStringOption({ groupBy: "sprint" }, "group-by", "groupBy"), "sprint");
  assert.equal(readStringOption({ "group-by": "type" }, "group-by", "groupBy"), "type");
  assert.equal(readStringOption({ "group-by": 42 }, "group-by", "groupBy"), "42");
});

test("readStringOption returns undefined when no key is defined or value is null", () => {
  assert.equal(readStringOption({}, "format"), undefined);
  assert.equal(readStringOption({ format: null }, "format"), undefined);
  assert.equal(readStringOption({ format: undefined }, "format"), undefined);
});

// ---------------------------------------------------------------------------
// readImportFormat — every alias + default + error
// ---------------------------------------------------------------------------

test("readImportFormat defaults to markdown when absent", () => {
  assert.equal(readImportFormat({}), "markdown");
  assert.equal(readImportFormat({ format: undefined }), "markdown");
});

test("readImportFormat recognises every documented markdown alias", () => {
  for (const alias of ["markdown", "md"]) {
    assert.equal(readImportFormat({ format: alias }), "markdown", alias);
  }
});

test("readImportFormat recognises every todotxt alias", () => {
  for (const alias of ["todotxt", "todo.txt", "TODOTXT"]) {
    assert.equal(readImportFormat({ format: alias }), "todotxt", alias);
  }
});

test("readImportFormat recognises every todojson alias", () => {
  for (const alias of ["todojson", "todo-json", "todo", "pi-todo", "pi-todos"]) {
    assert.equal(readImportFormat({ format: alias }), "todojson", alias);
  }
});

test("readImportFormat recognises every jsonl alias", () => {
  for (const alias of ["jsonl", "json-lines", "jsonline", "json-line"]) {
    assert.equal(readImportFormat({ format: alias }), "jsonl", alias);
  }
});

test("readImportFormat recognises every checkbox alias", () => {
  for (const alias of ["checkbox", "checkbox-md", "checkbox-markdown"]) {
    assert.equal(readImportFormat({ format: alias }), "checkbox", alias);
  }
});

test("readImportFormat throws USAGE on an unknown format", () => {
  assert.throws(
    () => readImportFormat({ format: "yaml" }),
    (err: unknown) => err instanceof Error && "exitCode" in err && /Unknown --format/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// readExportFormat — every alias + default + error
// ---------------------------------------------------------------------------

test("readExportFormat defaults to markdown when absent", () => {
  assert.equal(readExportFormat({}), "markdown");
});

test("readExportFormat recognises markdown, todotxt, todojson, jsonl, checkbox aliases", () => {
  assert.equal(readExportFormat({ format: "md" }), "markdown");
  assert.equal(readExportFormat({ format: "todo.txt" }), "todotxt");
  assert.equal(readExportFormat({ format: "pi-todo" }), "todojson");
  assert.equal(readExportFormat({ format: "json-lines" }), "jsonl");
  assert.equal(readExportFormat({ format: "checkbox-md" }), "checkbox");
});

test("readExportFormat recognises tasklist aliases (export-only)", () => {
  for (const alias of ["tasklist", "task-list", "gfm"]) {
    assert.equal(readExportFormat({ format: alias }), "tasklist", alias);
  }
});

test("readExportFormat throws USAGE on an unknown format", () => {
  assert.throws(
    () => readExportFormat({ format: "csv" }),
    (err: unknown) => err instanceof Error && "exitCode" in err && /Unknown --format/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// readGroupBy
// ---------------------------------------------------------------------------

test("readGroupBy returns undefined when absent and accepts status|sprint|type", () => {
  assert.equal(readGroupBy({}), undefined);
  assert.equal(readGroupBy({ "group-by": "status" }), "status");
  assert.equal(readGroupBy({ groupBy: "SPRINT" }), "sprint");
  assert.equal(readGroupBy({ "group-by": "Type" }), "type");
});

test("readGroupBy throws USAGE on an unknown value", () => {
  assert.throws(
    () => readGroupBy({ "group-by": "assignee" }),
    (err: unknown) => err instanceof Error && "exitCode" in err && /Unknown --group-by/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// readSort
// ---------------------------------------------------------------------------

test("readSort returns undefined when absent and accepts priority|deadline|title", () => {
  assert.equal(readSort({}), undefined);
  assert.equal(readSort({ sort: "priority" }), "priority");
  assert.equal(readSort({ sort: "DEADLINE" }), "deadline");
  assert.equal(readSort({ sort: "Title" }), "title");
});

test("readSort throws USAGE on an unknown value", () => {
  assert.throws(
    () => readSort({ sort: "created" }),
    (err: unknown) => err instanceof Error && "exitCode" in err && /Unknown --sort/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// readPriorityMap
// ---------------------------------------------------------------------------

test("readPriorityMap defaults to number and recognises every alias", () => {
  assert.equal(readPriorityMap({}), "number");
  for (const alias of ["number", "numbers", "num", "p"]) {
    assert.equal(readPriorityMap({ "priority-map": alias }), "number", alias);
  }
  for (const alias of ["letter", "letters", "alpha", "a"]) {
    assert.equal(readPriorityMap({ priorityMap: alias }), "letter", alias);
  }
});

test("readPriorityMap throws USAGE on an unknown value", () => {
  assert.throws(
    () => readPriorityMap({ "priority-map": "hex" }),
    (err: unknown) => err instanceof Error && "exitCode" in err && /Unknown --priority-map/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// readExportFilter
// ---------------------------------------------------------------------------

test("parseFilterExpression skips empty comma-separated tokens", () => {
  assert.deepEqual(parseFilterExpression("status=open,,type=Task,"), { status: "open", type: "Task" });
});

test("readExportFilter merges explicit options with --filter (explicit wins)", () => {
  assert.deepEqual(readExportFilter({ status: "open" }), { status: "open", type: undefined });
  assert.deepEqual(readExportFilter({ type: "Task" }), { status: undefined, type: "Task" });
  assert.deepEqual(readExportFilter({ filter: "status=open,type=Task" }), { status: "open", type: "Task" });
  assert.deepEqual(readExportFilter({ status: "closed", filter: "status=open" }), { status: "closed", type: undefined });
  assert.deepEqual(readExportFilter({}), { status: undefined, type: undefined });
});

// ---------------------------------------------------------------------------
// readBoundedIntOption
// ---------------------------------------------------------------------------

test("readBoundedIntOption returns the default when absent", () => {
  assert.equal(
    readBoundedIntOption({}, { key: "limit", label: "--limit", min: 1, max: 200, defaultValue: 20 }),
    20,
  );
});

test("readBoundedIntOption accepts a valid integer in range", () => {
  assert.equal(
    readBoundedIntOption({ limit: "10" }, { key: "limit", label: "--limit", min: 1, max: 200, defaultValue: 20 }),
    10,
  );
});

test("readBoundedIntOption rejects non-digit input", () => {
  assert.throws(
    () => readBoundedIntOption({ limit: "abc" }, { key: "limit", label: "--limit", min: 1, max: 200, defaultValue: 20 }),
    /Invalid --limit/,
  );
});

test("readBoundedIntOption rejects out-of-range values", () => {
  assert.throws(
    () => readBoundedIntOption({ limit: "0" }, { key: "limit", label: "--limit", min: 1, max: 200, defaultValue: 20 }),
    /expected 1-200/,
  );
  assert.throws(
    () => readBoundedIntOption({ limit: "201" }, { key: "limit", label: "--limit", min: 1, max: 200, defaultValue: 20 }),
    /expected 1-200/,
  );
});

// ---------------------------------------------------------------------------
// extractPriority — (pN) markers and bang (!/!!/!!!) markers
// ---------------------------------------------------------------------------

test("extractPriority strips (pN) markers and returns the numeric priority", () => {
  assert.deepEqual(extractPriority("Task (p2)"), { text: "Task", priority: 2 });
  assert.deepEqual(extractPriority("(p0) urgent"), { text: "urgent", priority: 0 });
});

test("extractPriority strips bang markers when no (pN) is present", () => {
  assert.deepEqual(extractPriority("! task"), { text: "task", priority: 2 });
  assert.deepEqual(extractPriority("!! task"), { text: "task", priority: 1 });
  assert.deepEqual(extractPriority("!!! task"), { text: "task", priority: 0 });
});

test("extractPriority ignores bangs inside words and returns no priority", () => {
  assert.deepEqual(extractPriority("ship it!"), { text: "ship it!", priority: undefined });
  assert.deepEqual(extractPriority("a!b"), { text: "a!b", priority: undefined });
});

test("extractPriority returns text unchanged with no markers", () => {
  assert.deepEqual(extractPriority("just a task"), { text: "just a task", priority: undefined });
});

// ---------------------------------------------------------------------------
// filterBySection
// ---------------------------------------------------------------------------

test("filterBySection keeps only todos whose section matches case-insensitively", () => {
  const todos = parseMarkdownTodos("## Backlog\n- [ ] A\n## Done\n- [x] B\n");
  const backlog = filterBySection(todos, "backlog");
  assert.equal(backlog.length, 1);
  assert.equal(backlog[0]!.text, "A");
  const done = filterBySection(todos, "DONE");
  assert.equal(done.length, 1);
  assert.equal(done[0]!.text, "B");
});

// ---------------------------------------------------------------------------
// mapStatusToPm / mapPmStatusToChecked
// ---------------------------------------------------------------------------

test("mapStatusToPm maps checked to closedAs and unchecked to openAs", () => {
  assert.equal(mapStatusToPm(true, "closed"), "closed");
  assert.equal(mapStatusToPm(false, "closed"), "open");
  assert.equal(mapStatusToPm(true, "canceled", "draft"), "canceled");
  assert.equal(mapStatusToPm(false, "canceled", "draft"), "draft");
});

test("mapPmStatusToChecked is true for closed and canceled only", () => {
  assert.equal(mapPmStatusToChecked("closed"), true);
  assert.equal(mapPmStatusToChecked("canceled"), true);
  assert.equal(mapPmStatusToChecked("open"), false);
  assert.equal(mapPmStatusToChecked("in_progress"), false);
});

// ---------------------------------------------------------------------------
// sectionToTag
// ---------------------------------------------------------------------------

test("sectionToTag lowercases, replaces spaces with hyphens, strips punctuation", () => {
  assert.equal(sectionToTag("In Progress"), "in-progress");
  assert.equal(sectionToTag("Backlog"), "backlog");
  assert.equal(sectionToTag("Q1 2026"), "q1-2026");
  assert.equal(sectionToTag("Bugs & Issues"), "bugs-issues");
});

// ---------------------------------------------------------------------------
// shouldRefreshTodojsonDescription
// ---------------------------------------------------------------------------

test("shouldRefreshTodojsonDescription returns true for missing description", () => {
  assert.equal(shouldRefreshTodojsonDescription(undefined, 5), true);
  assert.equal(shouldRefreshTodojsonDescription("", 5), true);
});

test("shouldRefreshTodojsonDescription returns true when stored id differs", () => {
  assert.equal(
    shouldRefreshTodojsonDescription("Imported from f line 1 (todo-id:3)", 5),
    true,
  );
});

test("shouldRefreshTodojsonDescription returns false when stored id matches", () => {
  assert.equal(
    shouldRefreshTodojsonDescription("Imported from f line 1 (todo-id:5)", 5),
    false,
  );
});

test("shouldRefreshTodojsonDescription returns false for a non-canonical custom description", () => {
  // A custom description that is neither the canonical import-provenance marker
  // nor carries a todo-id is left untouched — refreshing would overwrite
  // user-authored content.
  assert.equal(
    shouldRefreshTodojsonDescription("some other text", 5),
    false,
  );
});

test("shouldRefreshTodojsonDescription returns true for canonical description without id", () => {
  // A canonical import-provenance marker that lacks a todo-id is refreshed so
  // the id marker is added.
  assert.equal(
    shouldRefreshTodojsonDescription("Imported from f line 1", 5),
    true,
  );
});

// ---------------------------------------------------------------------------
// parseTimestamp
// ---------------------------------------------------------------------------

test("parseTimestamp returns Infinity for missing or invalid values", () => {
  assert.equal(parseTimestamp(undefined), Number.POSITIVE_INFINITY);
  assert.equal(parseTimestamp(""), Number.POSITIVE_INFINITY);
  assert.equal(parseTimestamp("not-a-date"), Number.POSITIVE_INFINITY);
});

test("parseTimestamp returns the epoch ms for a valid ISO string", () => {
  assert.equal(parseTimestamp("2026-01-01T00:00:00.000Z"), Date.parse("2026-01-01T00:00:00.000Z"));
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
  assert.deepEqual(sortItems([
    { id: "none", title: "None", status: "open" },
    { id: "dated", title: "Dated", status: "open", deadline: "2026-06-01" },
  ], "deadline").map((item) => item.id), ["dated", "none"]);
});

test("sortItemsForContext breaks a complete urgency tie by title and handles unknown fields", () => {
  const items = [
    { id: "b", title: "Zulu", status: "mystery", priority: 1, deadline: "2026-06-10", updated_at: "2026-06-01" },
    { id: "a", title: "alpha", status: "mystery", priority: 1, deadline: "2026-06-10", updated_at: "2026-06-01" },
  ];
  assert.deepEqual(sortItemsForContext(items).map((item) => item.id), ["a", "b"]);
  const contextPairs = [
    [{ id: "known", title: "Known", status: "open", priority: 1 }, { id: "missing", title: "Missing", status: "mystery" }],
    [{ id: "missing", title: "Missing", status: "mystery" }, { id: "known", title: "Known", status: "open", priority: 1 }],
    [{ id: "due", title: "Due", status: "open", deadline: "2026-06-01" }, { id: "no-due", title: "No due", status: "open" }],
    [{ id: "no-due", title: "No due", status: "open" }, { id: "due", title: "Due", status: "open", deadline: "2026-06-01" }],
    [{ id: "updated", title: "Updated", status: "open", updated_at: "2026-06-02" }, { id: "no-updated", title: "No updated", status: "open" }],
    [{ id: "no-updated", title: "No updated", status: "open" }, { id: "updated", title: "Updated", status: "open", updated_at: "2026-06-02" }],
  ] as const;
  for (const pair of contextPairs) sortItemsForContext([...pair]);
});

test("buildTodoContextSnapshot uses unknown status/type fallbacks", () => {
  const snapshot = buildTodoContextSnapshot([
    { id: "unknown", title: "Unknown", status: " ", type: " " },
    { id: "open", title: "Open", status: "open", type: "Task" },
  ], { limit: 2, nowIso: "2026-06-10T00:00:00.000Z" });
  assert.equal(snapshot.counts.byStatus["(unknown)"], 1);
  assert.equal(snapshot.counts.byType["(none)"], 1);
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

test("serializeTodoTxtLine handles absent tags and metadata markers", () => {
  assert.equal(serializeTodoTxtLine({ id: "bare", title: "Bare", status: "open" }), "Bare");
  assert.equal(renderDefaultMarkdown([{ id: "bare", title: "Bare", status: "open" }], "2026-06-10T00:00:00.000Z", true), "# TODO\n\n<!-- Exported from pm-cli on 2026-06-10T00:00:00.000Z -->\n\n## Open\n\n- [ ] Bare <!-- bare -->\n");
});

test("todojson source and provenance helpers cover absent and non-positive ids", () => {
  assert.equal(extractTodojsonSourceId("Imported from f line 1 (todo-id:0)"), undefined);
  assert.equal(buildTodojsonImportDescription(undefined, 4), "Imported from stdin line 4");
  assert.deepEqual(extractTrailing("text", /text$/), { text: "", value: undefined });
});

test("parseFileToNormalized leaves an absent jsonl id without a pm id", () => {
  const [todo] = parseFileToNormalized(JSON.stringify({ title: "No pm id", status: "open" }), undefined, "jsonl");
  assert.equal(todo.pmId, undefined);
});

test("serializeJsonl omits empty optional arrays and objects", () => {
  const line = serializeJsonl([
    { id: "empty", title: "Empty", status: "open", tags: [], kv: {} },
  ]);
  assert.equal(JSON.parse(line).id, "empty");
  assert.equal("tags" in JSON.parse(line), false);
  assert.equal("kv" in JSON.parse(line), false);
});

test("parseJsonl preserves every optional field when present", () => {
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

test("buildExistingTodoIndex skips idless and empty-title signature rows", () => {
  const index = buildExistingTodoIndex([
    { id: "", title: "No id", status: "open" },
    { id: "pm-empty-title", title: "   ", status: "open" },
    { id: "pm-missing-title", title: undefined as unknown as string, status: "open" },
  ]);
  assert.equal(index.byId.size, 2);
  assert.equal(index.bySig.size, 0);
});

test("serializePiTodoDetails resolves equal timestamps, ids, and titles deterministically", () => {
  const output = JSON.parse(serializePiTodoDetails([
    { id: "b", title: "Same", status: "open", created_at: "2026-01-01" },
    { id: "a", title: "Same", status: "open", created_at: "2026-01-01" },
    { id: undefined as unknown as string, title: "No id", status: "open", created_at: "2026-01-01" },
  ])) as { todos: Array<{ id: number; text: string }> };
  assert.deepEqual(output.todos.map((todo) => todo.text), ["No id", "Same", "Same"]);
});

test("groupItems compares two unassigned buckets without throwing", () => {
  const groups = groupItems([
    { id: "a", title: "A", status: "open" },
    { id: "b", title: "B", status: "open" },
  ], "sprint");
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.heading, "(unassigned)");
});

test("preflight reports file-level todojson errors without line text", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-todos-preflight-"));
  const file = join(dir, "bad.json");
  writeFileSync(file, "not json");
  assert.throws(() => preflightValidateImportFiles([file], "todojson"), (err: unknown) => err instanceof Error && /file:/.test(err.message));
  rmSync(dir, { recursive: true, force: true });
});

test("resolveGlob stops descending beyond its safety depth", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-todos-deep-"));
  let nested = dir;
  for (let i = 0; i < 14; i++) {
    nested = join(nested, `d${i}`);
    mkdirSync(nested);
  }
  writeFileSync(join(nested, "deep.md"), "- [ ] too deep\n");
  assert.deepEqual(resolveGlob("**/*.md", dir), []);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// globToRegExp
// ---------------------------------------------------------------------------

test("globToRegExp matches literal paths", () => {
  const re = globToRegExp("TODO.md");
  assert.ok(re.test("TODO.md"));
  assert.ok(!re.test("TODO.txt"));
});

test("globToRegExp matches * as non-separator wildcard", () => {
  const re = globToRegExp("*.md");
  assert.ok(re.test("TODO.md"));
  assert.ok(re.test("list.md"));
  assert.ok(!re.test("sub/TODO.md"));
});

test("globToRegExp matches ** across directory separators", () => {
  const re = globToRegExp("docs/**/*.md");
  assert.ok(re.test("docs/a.md"));
  assert.ok(re.test("docs/sub/b.md"));
  assert.ok(re.test("docs/x/y/c.md"));
});

test("globToRegExp matches ? as single non-separator char", () => {
  const re = globToRegExp("TODO?.md");
  assert.ok(re.test("TODO1.md"));
  assert.ok(!re.test("TODO12.md"));
});

test("globToRegExp escapes regex metacharacters in the pattern", () => {
  const re = globToRegExp("file.txt");
  assert.ok(re.test("file.txt"));
  assert.ok(!re.test("filextxt"));
  const re2 = globToRegExp("a+b");
  assert.ok(re2.test("a+b"));
  assert.ok(!re2.test("aXXb"));
});

test("resolveGlob ignores an unreadable working directory and broken symlink", () => {
  assert.deepEqual(resolveGlob("*.md", "/no/such/pm-todos-directory"), []);
  const dir = mkdtempSync(join(tmpdir(), "pm-todos-glob-"));
  try {
    symlinkSync(join(dir, "missing.md"), join(dir, "broken.md"));
    assert.deepEqual(resolveGlob("*.md", dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// parseFileToNormalized — every format branch
// ---------------------------------------------------------------------------

test("parseFileToNormalized parses markdown format", () => {
  const todos = parseFileToNormalized("## Open\n- [ ] Task\n- [x] Done\n", "f.md", "markdown");
  assert.equal(todos.length, 2);
  assert.equal(todos[0]!.text, "Task");
  assert.equal(todos[0]!.checked, false);
  assert.equal(todos[1]!.text, "Done");
  assert.equal(todos[1]!.checked, true);
});

test("parseFileToNormalized parses checkbox format (same grammar as markdown)", () => {
  const todos = parseFileToNormalized("- [ ] Task\n- [x] Done\n", "f.md", "checkbox");
  assert.equal(todos.length, 2);
  assert.equal(todos[0]!.text, "Task");
  assert.equal(todos[1]!.checked, true);
});

test("parseFileToNormalized parses todotxt format", () => {
  const todos = parseFileToNormalized("(A) Task +proj due:2026-07-01\nx Done\n", "f.txt", "todotxt");
  assert.equal(todos.length, 2);
  assert.equal(todos[0]!.text, "Task");
  assert.equal(todos[0]!.priority, 0);
  assert.deepEqual(todos[0]!.tags, ["proj"]);
  assert.equal(todos[1]!.checked, true);
});

test("parseFileToNormalized parses todojson format", () => {
  const content = JSON.stringify({ action: "list", todos: [{ id: 1, text: "A", done: false }], nextId: 2 });
  const todos = parseFileToNormalized(content, "f.json", "todojson");
  assert.equal(todos.length, 1);
  assert.equal(todos[0]!.text, "A");
  assert.equal(todos[0]!.checked, false);
  assert.equal(todos[0]!.todoId, 1);
  assert.deepEqual(todos[0]!.tags, ["todo"]);
});

test("parseFileToNormalized parses jsonl format with full metadata", () => {
  const content = JSON.stringify({
    id: "pm-1", title: "Task", status: "in_progress", priority: 2,
    tags: ["x"], deadline: "2026-07-01T00:00:00.000Z", type: "Bug",
    assignee: "alice", sprint: "S1", kv: { k: "v" },
  }) + "\n";
  const todos = parseFileToNormalized(content, "f.jsonl", "jsonl");
  assert.equal(todos.length, 1);
  assert.equal(todos[0]!.text, "Task");
  assert.equal(todos[0]!.status, "in_progress");
  assert.equal(todos[0]!.priority, 2);
  assert.equal(todos[0]!.pmId, "pm-1");
  assert.equal(todos[0]!.itemType, "Bug");
  assert.equal(todos[0]!.assignee, "alice");
  assert.equal(todos[0]!.sprint, "S1");
  assert.deepEqual(todos[0]!.kv, { k: "v" });
});

// ---------------------------------------------------------------------------
// pmJsonMaxBuffer
// ---------------------------------------------------------------------------

test("pmJsonMaxBuffer returns the default when PM_JSON_MAX_BUFFER is unset", () => {
  const before = process.env.PM_JSON_MAX_BUFFER;
  delete process.env.PM_JSON_MAX_BUFFER;
  try {
    assert.equal(pmJsonMaxBuffer(), 64 * 1024 * 1024);
  } finally {
    if (before !== undefined) process.env.PM_JSON_MAX_BUFFER = before;
  }
});

test("pmJsonMaxBuffer honours a valid positive integer env var", () => {
  const before = process.env.PM_JSON_MAX_BUFFER;
  process.env.PM_JSON_MAX_BUFFER = "1048576";
  try {
    assert.equal(pmJsonMaxBuffer(), 1048576);
  } finally {
    if (before !== undefined) process.env.PM_JSON_MAX_BUFFER = before;
    else delete process.env.PM_JSON_MAX_BUFFER;
  }
});

test("pmJsonMaxBuffer falls back to default for invalid or non-positive values", () => {
  const before = process.env.PM_JSON_MAX_BUFFER;
  for (const bad of ["abc", "-1", "0", "1.5", ""]) {
    process.env.PM_JSON_MAX_BUFFER = bad;
    assert.equal(pmJsonMaxBuffer(), 64 * 1024 * 1024, `should fall back for '${bad}'`);
  }
  // NaN from a non-numeric string (Number, not parseInt, so "64MiB" → NaN)
  process.env.PM_JSON_MAX_BUFFER = "64MiB";
  assert.equal(pmJsonMaxBuffer(), 64 * 1024 * 1024);
  // Restoring
  if (before !== undefined) process.env.PM_JSON_MAX_BUFFER = before;
  else delete process.env.PM_JSON_MAX_BUFFER;
});

// ---------------------------------------------------------------------------
// describePmReadFailure
// ---------------------------------------------------------------------------

test("describePmReadFailure names ENOBUFS as a buffer overrun", () => {
  const err = new Error("spawn ENOBUFS") as NodeJS.ErrnoException;
  err.code = "ENOBUFS";
  assert.match(describePmReadFailure(err, 1024), /exceeded the 1024 byte read buffer/);
});

test("describePmReadFailure falls back to a generic message for other errors", () => {
  const err = new Error("something went wrong");
  assert.match(describePmReadFailure(err, 1024), /pm read failed: something went wrong/);
});

// ---------------------------------------------------------------------------
// runPmCommand — POSIX path (Linux/macOS)
// ---------------------------------------------------------------------------

test("runPmCommand resolves pm from PATH on POSIX and returns spawnSync result", () => {
  const result = runPmCommand(["--version"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\d+\.\d+\.\d+/);
});

// ---------------------------------------------------------------------------
// runPmCommand — Windows path (simulated by overriding process.platform)
// ---------------------------------------------------------------------------

test("runPmCommand on Windows throws when PM_CLI_PACKAGE_ROOT is unset", () => {
  const originalPlatform = process.platform;
  const originalRoot = process.env.PM_CLI_PACKAGE_ROOT;
  delete process.env.PM_CLI_PACKAGE_ROOT;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    assert.throws(
      () => runPmCommand(["--version"]),
      /did not publish PM_CLI_PACKAGE_ROOT/,
    );
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (originalRoot !== undefined) process.env.PM_CLI_PACKAGE_ROOT = originalRoot;
  }
});

test("runPmCommand on Windows throws for an unreadable package metadata", () => {
  const originalPlatform = process.platform;
  const originalRoot = process.env.PM_CLI_PACKAGE_ROOT;
  process.env.PM_CLI_PACKAGE_ROOT = "/no/such/dir";
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    assert.throws(
      () => runPmCommand(["--version"]),
      /Could not read the installed pm CLI package metadata/,
    );
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (originalRoot !== undefined) process.env.PM_CLI_PACKAGE_ROOT = originalRoot;
    else delete process.env.PM_CLI_PACKAGE_ROOT;
  }
});

test("runPmCommand on Windows throws when bin.pm is missing", () => {
  const originalPlatform = process.platform;
  const originalRoot = process.env.PM_CLI_PACKAGE_ROOT;
  const tmpDir = mkdtempSync(join(tmpdir(), "pm-todos-win-"));
  writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "fake" }));
  process.env.PM_CLI_PACKAGE_ROOT = tmpDir;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    assert.throws(
      () => runPmCommand(["--version"]),
      /does not declare its pm executable/,
    );
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (originalRoot !== undefined) process.env.PM_CLI_PACKAGE_ROOT = originalRoot;
    else delete process.env.PM_CLI_PACKAGE_ROOT;
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("runPmCommand on Windows throws when bin.pm points outside the package root", () => {
  const originalPlatform = process.platform;
  const originalRoot = process.env.PM_CLI_PACKAGE_ROOT;
  const tmpDir = mkdtempSync(join(tmpdir(), "pm-todos-win-"));
  writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "fake", bin: { pm: "../escape.js" } }));
  process.env.PM_CLI_PACKAGE_ROOT = tmpDir;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    assert.throws(
      () => runPmCommand(["--version"]),
      /outside its package root/,
    );
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (originalRoot !== undefined) process.env.PM_CLI_PACKAGE_ROOT = originalRoot;
    else delete process.env.PM_CLI_PACKAGE_ROOT;
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("runPmCommand on Windows resolves the CLI entry and spawns node", () => {
  const originalPlatform = process.platform;
  const originalRoot = process.env.PM_CLI_PACKAGE_ROOT;
  // Point at the real pm-cli package root so the resolution succeeds.
  const realRoot = resolve(join(process.cwd(), "node_modules", "@unbrained", "pm-cli"));
  process.env.PM_CLI_PACKAGE_ROOT = realRoot;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const result = runPmCommand(["--version"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\d+\.\d+\.\d+/);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (originalRoot !== undefined) process.env.PM_CLI_PACKAGE_ROOT = originalRoot;
    else delete process.env.PM_CLI_PACKAGE_ROOT;
  }
});

test("readCompletePmItems reports a pm process error when the executable is unavailable", () => {
  const before = process.env.PATH;
  process.env.PATH = "/no/such/pm-bin";
  try {
    assert.throws(() => readCompletePmItems("/tmp/unused", "error coverage"), /pm read failed/);
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  }
});

test("readCompletePmItems rejects a non-zero pm status", () => {
  assert.throws(() => readCompletePmItems("/no/such/pm-todos-tracker", "status coverage"), /Tracker is not initialized|pm list --all failed|Could not parse/);
});

test("readCompletePmItems rejects non-JSON stdout from a successful pm process", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-todos-pm-"));
  const before = process.env.PATH;
  symlinkSync("/bin/echo", join(dir, "pm"));
  process.env.PATH = dir;
  try {
    assert.throws(() => readCompletePmItems("/tmp/unused", "parse coverage"), /Could not parse/);
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTodoImport reports a missing source file before any pm write", () => {
  type ImportOptions = Parameters<typeof runTodoImport>[0];
  const options: ImportOptions = {
    files: ["/no/such/pm-todos-source.md"],
    itemType: "Task",
    closedAs: "closed",
    extraTags: [],
    sectionTags: true,
    dryRun: false,
    pmRoot: "/tmp/unused",
    format: "markdown",
  };
  assert.throws(() => runTodoImport(options), /Failed to read file/);
});

// ---------------------------------------------------------------------------
// parsePiTodoDetails — error branches (for parsePiTodo line coverage)
// ---------------------------------------------------------------------------

test("parsePiTodoDetails throws on invalid JSON", () => {
  assert.throws(() => parsePiTodoDetails("{not json"), /Invalid todojson/);
});

test("parsePiTodoDetails throws when the payload has no todos array", () => {
  assert.throws(() => parsePiTodoDetails(JSON.stringify({ action: "list" })), /expected a TodoDetails object/);
  assert.throws(() => parsePiTodoDetails("42"), /expected a TodoDetails object/);
});

test("parsePiTodoDetails throws when a todo element is malformed", () => {
  assert.throws(
    () => parsePiTodoDetails(JSON.stringify([{ id: "x", text: "A", done: false }])),
    /invalid id/,
  );
  assert.throws(
    () => parsePiTodoDetails(JSON.stringify([{ id: 1, text: "", done: false }])),
    /invalid text/,
  );
  assert.throws(
    () => parsePiTodoDetails(JSON.stringify([{ id: 1, text: "A", done: "yes" }])),
    /invalid done/,
  );
  assert.throws(
    () => parsePiTodoDetails(JSON.stringify(["not-an-object"])),
    /is not an object/,
  );
});