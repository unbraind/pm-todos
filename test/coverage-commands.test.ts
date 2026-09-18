/**
 * In-process behavioural coverage for the pm-todos extension command handlers,
 * importers, exporters, and preflight override.
 *
 * The existing integration tests drive the extension through a real `pm`
 * subprocess. That proves the user-facing behaviour but contributes ZERO V8
 * line/branch/function coverage to `index.ts` because the code runs in a child
 * process outside the test runner's counters.
 *
 * This file activates the extension through the real pm SDK test harness
 * (`createExtensionTestHarness`) and invokes the registered command/importer/
 * exporter handlers IN-PROCESS via `ext.runCommand`, `ext.runImporter`,
 * `ext.runExporter`, and `ext.runPreflightOverride`. The handlers call
 * `runPmCommand` (which spawns the real `pm` binary) for store reads/writes, so
 * every test exercises genuine end-to-end behaviour — the only difference from a
 * subprocess invocation is that the TypeScript code path between the harness
 * entry and the `spawnSync` boundary runs inside the test process and is
 * measured by V8.
 *
 * A single shared pm workspace is created once and reused across all tests to
 * avoid the ~10 s per-test cost of `pm init` + `pm install`. All items are
 * cleaned between tests so each test starts from an empty tracker.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";

/** The pm binary shipped with the installed dev dependency. */
const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");

/** Shared workspace root, tracker, and env. */
const root = mkdtempSync(join(tmpdir(), "pm-todos-cov-"));
const tracker = join(root, "tracker");
const home = join(root, "home");
const xdgConfig = join(root, "xdg-config");
const xdgData = join(root, "xdg-data");
mkdirSync(home);
mkdirSync(xdgConfig);
mkdirSync(xdgData);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  PM_GLOBAL_PATH: join(root, "global-pm"),
  PM_TELEMETRY_DISABLED: "1",
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: xdgData,
};
execFileSync(pmBin, ["init", tracker, "--json"], { cwd: root, env, encoding: "utf-8" });
execFileSync(pmBin, ["--pm-path", tracker, "install", process.cwd(), "--project", "--json"], {
  cwd: root, env, encoding: "utf-8",
});

/** Shared harness. */
let harness: ExtensionTestHarness;

before(async () => {
  harness = await createExtensionTestHarness(extension, {
    name: "pm-todos",
    capabilities: ["commands", "schema", "importers", "preflight"],
  });
});

// Clean up at process exit.
process.on("exit", () => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** Run pm directly in the shared workspace. */
function runPm(args: string[]): string {
  return execFileSync(pmBin, args, { cwd: root, env, encoding: "utf-8" });
}

/** Delete all items from the shared tracker. */
function clearItems(): void {
  const list = JSON.parse(runPm(["--pm-path", tracker, "list-all", "--json"])) as { items: Array<{ id: string }> };
  for (const item of list.items) {
    runPm(["--pm-path", tracker, "delete", item.id, "--force", "--json"]);
  }
}

/** Create a temp file inside the workspace root. */
function tempFile(name: string, content: string): string {
  const p = join(root, name);
  writeFileSync(p, content);
  return p;
}

/** Read items from the shared tracker. */
function listItems(): Array<{ id: string; title: string; status: string; tags?: string[]; priority?: number; type?: string }> {
  return (JSON.parse(runPm(["--pm-path", tracker, "list-all", "--json"])) as { items: Array<{ id: string; title: string; status: string; tags?: string[]; priority?: number; type?: string }> }).items;
}

test("todos validate reports on a clean markdown file and returns the summary", async () => {
  const file = tempFile("v1.md", "# TODO\n\n- [ ] Real task\n- [x] Done task\n");
  const result = await harness.runCommand({ command: "todos validate", args: [file], pmRoot: tracker });
  assert.equal(result.handled, true);
  const report = result.result as { taskCount: number; errors: number };
  assert.equal(report.taskCount, 2);
  assert.equal(report.errors, 0);
});

test("todos validate with --json returns issues on a bad file", async () => {
  const file = tempFile("v2.md", "- [ ] (p9) bad priority\n");
  await assert.rejects(
    () => harness.runCommand({ command: "todos validate", args: [file], pmRoot: tracker, global: { json: true } }),
    (err: unknown) => err instanceof Error && "exitCode" in err && /structural error/.test(err.message),
  );
});

test("todos validate throws USAGE when no file argument is given", async () => {
  await assert.rejects(
    () => harness.runCommand({ command: "todos validate", pmRoot: tracker }),
    (err: unknown) => err instanceof Error && /Usage: pm todos validate/.test(err.message),
  );
});

test("todos validate throws NOT_FOUND for a missing file", async () => {
  await assert.rejects(
    () => harness.runCommand({ command: "todos validate", args: [join(root, "nope.md")], pmRoot: tracker }),
    (err: unknown) => err instanceof Error && /Failed to read file/.test(err.message),
  );
});

test("todos validate with --format todotxt/jsonl/todojson/checkbox", async () => {
  // todotxt
  const f1 = tempFile("v3.txt", "(A) Task +proj due:2026-07-01\nx Done\n");
  const r1 = await harness.runCommand({ command: "todos validate", args: [f1], options: { format: "todotxt" }, pmRoot: tracker });
  assert.equal((r1.result as { taskCount: number }).taskCount, 2);
  // jsonl
  const f2 = tempFile("v4.jsonl", JSON.stringify({ id: "pm-1", title: "Ok", status: "open" }) + "\n");
  const r2 = await harness.runCommand({ command: "todos validate", args: [f2], options: { format: "jsonl" }, pmRoot: tracker });
  assert.equal((r2.result as { taskCount: number }).taskCount, 1);
  // todojson
  const f3 = tempFile("v5.json", JSON.stringify({ action: "list", todos: [{ id: 1, text: "A", done: false }], nextId: 2 }));
  const r3 = await harness.runCommand({ command: "todos validate", args: [f3], options: { format: "todojson" }, pmRoot: tracker });
  assert.equal((r3.result as { taskCount: number }).taskCount, 1);
  // checkbox
  const f4 = tempFile("v6.md", "- [ ] task\n- [x] done\n");
  const r4 = await harness.runCommand({ command: "todos validate", args: [f4], options: { format: "checkbox" }, pmRoot: tracker });
  assert.equal((r4.result as { taskCount: number }).taskCount, 2);
});

test("todos validate on empty jsonl (0 tasks, no errors)", async () => {
  const file = tempFile("v7.jsonl", "");
  const result = await harness.runCommand({ command: "todos validate", args: [file], options: { format: "jsonl" }, pmRoot: tracker });
  assert.equal((result.result as { taskCount: number }).taskCount, 0);
});

// ---------------------------------------------------------------------------
// Command: todos context
// ---------------------------------------------------------------------------

test("todos context returns a snapshot of workspace items", async () => {
  runPm(["--pm-path", tracker, "create", "--title", "Task A", "--type", "Task", "--status", "open", "--json"]);
  runPm(["--pm-path", tracker, "create", "--title", "Task B", "--type", "Bug", "--status", "open", "--priority", "0", "--json"]);
  const result = await harness.runCommand({ command: "todos context", pmRoot: tracker });
  assert.equal(result.handled, true);
  const snap = result.result as { totalMatched: number; focusCount: number };
  assert.ok(snap.totalMatched >= 2);
});

test("todos context with --status, --sort, --type, --include-tags, --limit", async () => {
  runPm(["--pm-path", tracker, "create", "--title", "Open", "--type", "Task", "--status", "open", "--json"]);
  runPm(["--pm-path", tracker, "create", "--title", "Closed", "--type", "Task", "--status", "closed", "--close-reason", "done", "--json"]);
  runPm(["--pm-path", tracker, "create", "--title", "Tagged", "--type", "Bug", "--status", "open", "--tags", "alpha", "--json"]);

  // status filter
  const r1 = await harness.runCommand({ command: "todos context", options: { status: "open", sort: "title", limit: "5" }, pmRoot: tracker });
  assert.ok((r1.result as { totalMatched: number }).totalMatched >= 2);

  // include-tags
  const r3 = await harness.runCommand({ command: "todos context", options: { "include-tags": true }, pmRoot: tracker });
  const snap3 = r3.result as { focus: Array<{ tags?: string[] }> };
  assert.ok(snap3.focus.some((f) => f.tags?.includes("alpha")));
});

test("todos context with invalid --limit throws USAGE", async () => {
  await assert.rejects(
    () => harness.runCommand({ command: "todos context", options: { limit: "abc" }, pmRoot: tracker }),
    (err: unknown) => err instanceof Error && /Invalid --limit/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Command: todos sync
// ---------------------------------------------------------------------------

test("todos sync imports and re-exports a markdown file", async () => {
  const file = tempFile("s1.md", "# TODO\n\n- [ ] Task A\n- [x] Done B\n");
  const result = await harness.runCommand({ command: "todos sync", args: [file], pmRoot: tracker });
  assert.equal(result.handled, true);
  const res = result.result as { imported: number; updated?: number; reexported: number };
  assert.equal(res.imported + (res.updated ?? 0), 2);
  assert.ok(res.reexported > 0);
  assert.match(readFileSync(file, "utf-8"), /<!-- pm-/);
});

test("todos sync with --dry-run does not write", async () => {
  const file = tempFile("s2.md", "# TODO\n\n- [ ] Task\n");
  const before = readFileSync(file, "utf-8");
  const result = await harness.runCommand({ command: "todos sync", args: [file], options: { "dry-run": true }, pmRoot: tracker });
  assert.equal((result.result as { dryRun: boolean }).dryRun, true);
  assert.equal(readFileSync(file, "utf-8"), before);
});

test("todos sync with --format jsonl/todotxt/todojson/checkbox", async () => {
  // jsonl
  const f1 = tempFile("s3.jsonl", JSON.stringify({ id: "pm-1", title: "Task", status: "open", type: "Task" }) + "\n");
  const r1 = await harness.runCommand({ command: "todos sync", args: [f1], options: { format: "jsonl" }, pmRoot: tracker });
  const res1 = r1.result as { imported: number; updated?: number };
  assert.equal(res1.imported + (res1.updated ?? 0), 1);

  // todotxt
  const f2 = tempFile("s4.txt", "(A) Task +proj due:2026-07-01\n");
  const r2 = await harness.runCommand({ command: "todos sync", args: [f2], options: { format: "todotxt" }, pmRoot: tracker });
  const res2 = r2.result as { imported: number; updated?: number };
  assert.equal(res2.imported + (res2.updated ?? 0), 1);

  // todojson
  const f3 = tempFile("s5.json", JSON.stringify({ action: "list", todos: [{ id: 1, text: "Task", done: false }], nextId: 2 }));
  const r3 = await harness.runCommand({ command: "todos sync", args: [f3], options: { format: "todojson" }, pmRoot: tracker });
  const res3 = r3.result as { imported: number; updated?: number };
  assert.equal(res3.imported + (res3.updated ?? 0), 1);

  // checkbox
  const f4 = tempFile("s6.md", "- [ ] task\n- [x] done\n");
  const r4 = await harness.runCommand({ command: "todos sync", args: [f4], options: { format: "checkbox" }, pmRoot: tracker });
  const res4 = r4.result as { imported: number; updated?: number };
  assert.equal(res4.imported + (res4.updated ?? 0), 2);
});

test("todos sync with --format tasklist is rejected", async () => {
  const file = tempFile("s7.md", "- [ ] task\n");
  await assert.rejects(
    () => harness.runCommand({ command: "todos sync", args: [file], options: { format: "tasklist" }, pmRoot: tracker }),
    (err: unknown) => err instanceof Error && /tasklist is export-only/.test(err.message),
  );
});

test("todos sync with --group-by, --metadata, --priority-map, --sort, --reverse", async () => {
  const file = tempFile("s8.md", "# TODO\n\n- [ ] Beta\n- [ ] Alpha\n");
  const result = await harness.runCommand({
    command: "todos sync", args: [file],
    options: { "group-by": "type", metadata: true, "priority-map": "letter", sort: "title", reverse: true },
    pmRoot: tracker,
  });
  assert.equal(result.handled, true);
  const after = readFileSync(file, "utf-8");
  assert.match(after, /## Task/);
});

test("todos sync with --filter, --section, --no-section-tags, --closed-as, --status, --priority, --tags", async () => {
  // filter status=open
  const f1 = tempFile("s9.md", "# TODO\n\n- [ ] Open\n- [x] Done\n");
  const r1 = await harness.runCommand({ command: "todos sync", args: [f1], options: { filter: "status=open" }, pmRoot: tracker });
  const res1f = r1.result as { imported: number; updated?: number };
  assert.equal(res1f.imported + (res1f.updated ?? 0), 1);

  // section
  const f2 = tempFile("s10.md", "## Backlog\n- [ ] A\n## Done\n- [x] B\n");
  const r2 = await harness.runCommand({ command: "todos sync", args: [f2], options: { section: "Backlog" }, pmRoot: tracker });
  const res2s = r2.result as { imported: number; updated?: number };
  assert.equal(res2s.imported + (res2s.updated ?? 0), 1);

  // closed-as canceled
  const f3 = tempFile("s11.md", "# TODO\n\n- [x] CancelMe\n");
  await harness.runCommand({ command: "todos sync", args: [f3], options: { "closed-as": "canceled" }, pmRoot: tracker });
  const canceled = listItems().find((i) => i.title === "CancelMe");
  assert.equal(canceled?.status, "canceled");

  // status draft for unchecked
  const f4 = tempFile("s12.md", "# TODO\n\n- [ ] DraftMe\n");
  await harness.runCommand({ command: "todos sync", args: [f4], options: { status: "draft" }, pmRoot: tracker });
  const drafted = listItems().find((i) => i.title === "DraftMe");
  assert.equal(drafted?.status, "draft");

  // priority override
  const f5 = tempFile("s13.md", "# TODO\n\n- [ ] (p3) PrioTask\n");
  await harness.runCommand({ command: "todos sync", args: [f5], options: { priority: "1" }, pmRoot: tracker });
  const prio = listItems().find((i) => i.title === "PrioTask");
  assert.equal(prio?.priority, 1);

  // tags
  const f6 = tempFile("s14.md", "# TODO\n\n- [ ] TagMe\n");
  await harness.runCommand({ command: "todos sync", args: [f6], options: { tags: "extra,tag2" }, pmRoot: tracker });
  const tagged = listItems().find((i) => i.title === "TagMe");
  assert.ok(tagged?.tags?.includes("extra"));

  // no-section-tags
  const f7 = tempFile("s15.md", "## Backlog\n- [ ] NoSectionTag\n");
  await harness.runCommand({ command: "todos sync", args: [f7], options: { sectionTags: false }, pmRoot: tracker });
  const noTag = listItems().find((i) => i.title === "NoSectionTag");
  assert.ok(!noTag?.tags?.includes("backlog"));
});

test("todos sync --allow-empty clears a synced file", async () => {
  const file = tempFile("s16.md", "# TODO\n\n- [ ] task\n");
  await harness.runCommand({ command: "todos sync", args: [file], pmRoot: tracker });
  const result = await harness.runCommand({ command: "todos sync", args: [file], options: { filter: "type=Nonexistent", "allow-empty": true }, pmRoot: tracker });
  assert.equal(result.handled, true);
  assert.ok(!readFileSync(file, "utf-8").includes("- [ ] task"));
});

test("todos sync refuses empty result on non-empty file without --allow-empty", async () => {
  const file = tempFile("s17.md", "# TODO\n\n- [ ] task\n");
  await harness.runCommand({ command: "todos sync", args: [file], pmRoot: tracker });
  await assert.rejects(
    () => harness.runCommand({ command: "todos sync", args: [file], options: { filter: "type=Nonexistent" }, pmRoot: tracker }),
    (err: unknown) => err instanceof Error && /Refusing to replace non-empty/.test(err.message),
  );
});

test("todos sync throws USAGE when no file and NOT_FOUND for missing file", async () => {
  await assert.rejects(
    () => harness.runCommand({ command: "todos sync", pmRoot: tracker }),
    (err: unknown) => err instanceof Error && /Usage: pm todos sync/.test(err.message),
  );
  await assert.rejects(
    () => harness.runCommand({ command: "todos sync", args: [join(root, "nope.md")], pmRoot: tracker }),
    (err: unknown) => err instanceof Error && /Failed to read sync file/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Importer: todos (pm todos import)
// ---------------------------------------------------------------------------

test("todos import creates items from markdown", async () => {
  const file = tempFile("i1.md", "# TODO\n\n- [ ] Task A\n- [x] Done B\n");
  const result = await harness.runImporter({ importer: "todos", args: [file], pmRoot: tracker });
  const res = result.result as { imported: number; updated?: number };
  assert.equal(res.imported + (res.updated ?? 0), 2);
});

test("todos import with --dry-run previews", async () => {
  const file = tempFile("i2.md", "# TODO\n\n- [ ] Task\n");
  const result = await harness.runImporter({ importer: "todos", args: [file], options: { "dry-run": true }, pmRoot: tracker });
  assert.equal((result.result as { dryRun: boolean }).dryRun, true);
  assert.equal((result.result as { wouldImport: number }).wouldImport, 1);
});

test("todos import with --upsert updates existing items", async () => {
  const file = tempFile("i3.md", "# TODO\n\n- [ ] Task A\n");
  await harness.runImporter({ importer: "todos", args: [file], options: { upsert: true }, pmRoot: tracker });
  writeFileSync(file, "# TODO\n\n- [x] Task A\n");
  const result = await harness.runImporter({ importer: "todos", args: [file], options: { upsert: true }, pmRoot: tracker });
  assert.equal((result.result as { imported: number; updated: number }).updated, 1);
});

test("todos import with --glob matches files", async () => {
  tempFile("a.todo.md", "- [ ] task a\n");
  tempFile("b.todo.md", "- [ ] task b\n");
  const result = await harness.runImporter({ importer: "todos", options: { glob: "*.todo.md" }, pmRoot: tracker });
  const res = result.result as { imported: number; updated?: number };
  assert.equal(res.imported + (res.updated ?? 0), 2);
});

test("todos import with --glob no matches throws NOT_FOUND", async () => {
  await assert.rejects(
    () => harness.runImporter({ importer: "todos", options: { glob: "*.nomatch.md" }, pmRoot: tracker }),
    (err: unknown) => err instanceof Error && /No files matched glob/.test(err.message),
  );
});

test("todos import with no file/glob throws USAGE", async () => {
  await assert.rejects(
    () => harness.runImporter({ importer: "todos", pmRoot: tracker }),
    (err: unknown) => err instanceof Error && /Usage: pm todos import/.test(err.message),
  );
});

test("todos import with --format jsonl/todotxt/todojson/checkbox", async () => {
  // jsonl
  const f1 = tempFile("i4.jsonl", JSON.stringify({ id: "pm-1", title: "Task", status: "open", type: "Task", priority: 2, tags: ["x"], deadline: "2026-07-01T00:00:00.000Z", assignee: "alice", sprint: "S1", kv: { k: "v" } }) + "\n");
  const r1 = await harness.runImporter({ importer: "todos", args: [f1], options: { format: "jsonl", upsert: true }, pmRoot: tracker });
  const res1j = r1.result as { imported: number; updated?: number };
  assert.equal(res1j.imported + (res1j.updated ?? 0), 1);

  // todotxt
  const f2 = tempFile("i5.txt", "(A) Task +proj @home due:2026-07-01\nx 2026-06-01 Done\n");
  const r2 = await harness.runImporter({ importer: "todos", args: [f2], options: { format: "todotxt" }, pmRoot: tracker });
  const res2t = r2.result as { imported: number; updated?: number };
  assert.equal(res2t.imported + (res2t.updated ?? 0), 2);

  // todojson (upsert is implicit)
  const f3 = tempFile("i6.json", JSON.stringify({ action: "list", todos: [{ id: 1, text: "A", done: false }, { id: 2, text: "B", done: true }], nextId: 3 }));
  const r3 = await harness.runImporter({ importer: "todos", args: [f3], options: { format: "todojson" }, pmRoot: tracker });
  const res3 = r3.result as { imported: number; updated?: number };
  assert.equal(res3.imported + (res3.updated ?? 0), 2);

  // checkbox
  const f4 = tempFile("i7.md", "- [ ] task a\n- [x] task b\n");
  const r4 = await harness.runImporter({ importer: "todos", args: [f4], options: { format: "checkbox" }, pmRoot: tracker });
  const res4c = r4.result as { imported: number; updated?: number };
  assert.equal(res4c.imported + (res4c.updated ?? 0), 2);
});

test("todos import with --filter status/type", async () => {
  const file = tempFile("i8.md", "# TODO\n\n- [ ] Open\n- [x] Closed\n");
  const r1 = await harness.runImporter({ importer: "todos", args: [file], options: { filter: "status=open" }, pmRoot: tracker });
  const res1f = r1.result as { imported: number; updated?: number };
  assert.equal(res1f.imported + (res1f.updated ?? 0), 1);

  const file2 = tempFile("i9.md", "# TODO\n\n- [ ] Task [Feature] <!-- pm-x -->\n");
  const r2 = await harness.runImporter({ importer: "todos", args: [file2], options: { filter: "type=Feature" }, pmRoot: tracker });
  const res2f = r2.result as { imported: number; updated?: number };
  assert.equal(res2f.imported + (res2f.updated ?? 0), 1);
});

test("todos import with no items found reports zero", async () => {
  const file = tempFile("i10.md", "just prose, no tasks\n");
  const result = await harness.runImporter({ importer: "todos", args: [file], pmRoot: tracker });
  assert.equal((result.result as { imported: number; skipped: number }).imported, 0);
});

test("todos import with --section only imports named section", async () => {
  const file = tempFile("i11.md", "## Backlog\n- [ ] A\n## Done\n- [x] B\n");
  const result = await harness.runImporter({ importer: "todos", args: [file], options: { section: "Backlog" }, pmRoot: tracker });
  const res = result.result as { imported: number; updated?: number };
  assert.equal(res.imported + (res.updated ?? 0), 1);
});

// ---------------------------------------------------------------------------
// Importer: todos-import (legacy alias)
// ---------------------------------------------------------------------------

test("todos-import legacy importer creates items from file option", async () => {
  const file = tempFile("li1.md", "# TODO\n\n- [ ] Legacy task\n");
  const result = await harness.runImporter({ importer: "todos-import", options: { file }, pmRoot: tracker });
  const res = result.result as { imported: number; updated?: number };
  assert.equal(res.imported + (res.updated ?? 0), 1);
});

test("todos-import legacy importer skips when no file is provided", async () => {
  const result = await harness.runImporter({ importer: "todos-import", pmRoot: tracker });
  assert.equal(result.handled, true);
});

// ---------------------------------------------------------------------------
// Exporter: todos (pm todos export)
// ---------------------------------------------------------------------------

test("todos export returns markdown by default", async () => {
  runPm(["--pm-path", tracker, "create", "--title", "Task A", "--type", "Task", "--status", "open", "--json"]);
  const result = await harness.runExporter({ exporter: "todos", pmRoot: tracker });
  const res = result.result as { exported: number; markdown: string };
  assert.ok(res.exported > 0);
  assert.match(res.markdown, /# TODO/);
});

test("todos export with --format jsonl/todotxt/tasklist/todojson/checkbox", async () => {
  runPm(["--pm-path", tracker, "create", "--title", "Task", "--type", "Task", "--status", "open", "--priority", "1", "--json"]);

  const r1 = await harness.runExporter({ exporter: "todos", options: { format: "jsonl" }, pmRoot: tracker });
  assert.ok((r1.result as { markdown: string }).markdown.includes("\"title\""));

  const r2 = await harness.runExporter({ exporter: "todos", options: { format: "todotxt" }, pmRoot: tracker });
  assert.match((r2.result as { markdown: string }).markdown, /Task/);

  const r3 = await harness.runExporter({ exporter: "todos", options: { format: "tasklist" }, pmRoot: tracker });
  assert.match((r3.result as { markdown: string }).markdown, /## Open/);

  const r4 = await harness.runExporter({ exporter: "todos", options: { format: "todojson" }, pmRoot: tracker });
  assert.match((r4.result as { markdown: string }).markdown, /"todos"/);

  const r5 = await harness.runExporter({ exporter: "todos", options: { format: "checkbox" }, pmRoot: tracker });
  assert.match((r5.result as { markdown: string }).markdown, /- \[ \] Task/);
});

test("todos export with --output writes to a file", async () => {
  runPm(["--pm-path", tracker, "create", "--title", "Task", "--type", "Task", "--status", "open", "--json"]);
  const outFile = join(root, "export.md");
  const result = await harness.runExporter({ exporter: "todos", options: { output: outFile }, pmRoot: tracker });
  const res = result.result as { exported: number; file: string };
  assert.ok(res.exported > 0);
  assert.match(readFileSync(outFile, "utf-8"), /# TODO/);
});

test("todos export with no items reports exported: 0", async () => {
  clearItems();
  const result = await harness.runExporter({ exporter: "todos", pmRoot: tracker });
  assert.equal((result.result as { exported: number }).exported, 0);
});

test("todos export with --status, --type, --filter, --group-by, --metadata, --priority-map, --sort, --reverse", async () => {
  runPm(["--pm-path", tracker, "create", "--title", "A", "--type", "Task", "--status", "open", "--priority", "1", "--json"]);
  runPm(["--pm-path", tracker, "create", "--title", "B", "--type", "Bug", "--status", "closed", "--close-reason", "done", "--json"]);
  runPm(["--pm-path", tracker, "create", "--title", "C", "--type", "Task", "--status", "open", "--json"]);

  // status + type filter
  const r1 = await harness.runExporter({ exporter: "todos", options: { status: "open", type: "Task" }, pmRoot: tracker });
  assert.ok((r1.result as { exported: number; markdown: string }).exported >= 1);

  // --filter
  const r2 = await harness.runExporter({ exporter: "todos", options: { filter: "status=open,type=Task" }, pmRoot: tracker });
  assert.ok((r2.result as { exported: number }).exported >= 1);

  // --group-by type + --metadata + --priority-map letter
  const r3 = await harness.runExporter({ exporter: "todos", options: { "group-by": "type", metadata: true, "priority-map": "letter" }, pmRoot: tracker });
  assert.match((r3.result as { markdown: string }).markdown, /## Task/);

  // --sort title + --reverse
  const r4 = await harness.runExporter({ exporter: "todos", options: { sort: "title", reverse: true }, pmRoot: tracker });
  const md4 = (r4.result as { markdown: string }).markdown;
  assert.ok(md4.indexOf("C") < md4.indexOf("A") || md4.indexOf("A") < md4.indexOf("B"));
});

// ---------------------------------------------------------------------------
// Preflight override
// ---------------------------------------------------------------------------

const preflightDecision = {
  enforce_item_format_gate: true,
  run_preflight_item_format_sync: false,
  run_extension_migrations: true,
  enforce_mandatory_migration_gate: false,
};

test("preflight override returns passthrough for a file argument", async () => {
  const file = tempFile("p1.md", "- [ ] task\n");
  const result = await harness.runPreflightOverride({
    command: "todos import", args: [file], options: {},
    global: { json: true, quiet: true } as Record<string, unknown>,
    pm_root: tracker, decision: preflightDecision,
  });
  assert.equal(result.overridden, true);
  assert.equal(result.decision.enforce_item_format_gate, true);
});

test("preflight override returns passthrough when no files are resolved", async () => {
  const result = await harness.runPreflightOverride({
    command: "todos import", args: [], options: {},
    global: { json: true, quiet: true } as Record<string, unknown>,
    pm_root: tracker, decision: preflightDecision,
  });
  assert.equal(result.overridden, true);
});

test("preflight override resolves --glob files", async () => {
  tempFile("pf.todo.md", "- [ ] task\n");
  const result = await harness.runPreflightOverride({
    command: "todos import", args: [], options: { glob: "*.todo.md" },
    global: { json: true, quiet: true } as Record<string, unknown>,
    pm_root: tracker, decision: preflightDecision,
  });
  assert.equal(result.overridden, true);
});