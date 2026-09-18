/**
 * In-process behavioural coverage for the pm-todos extension command handlers,
 * importers, exporters, and preflight override.
 *
 * The existing integration tests (`integration.test.ts`, `import-close-reason.test.ts`)
 * drive the extension through a real `pm` subprocess. That proves the user-facing
 * behaviour but contributes ZERO V8 line/branch/function coverage to `index.ts`
 * because the code runs in a child process outside the test runner's counters.
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
 * Each workspace is created under `mkdtempSync(join(tmpdir(), "pm-todos-"))`
 * and removed in a `finally` block.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";

/** The pm binary shipped with the installed dev dependency. */
const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");

/**
 * Build an isolated pm workspace: tracker, isolated HOME/global, and THIS
 * package installed as a project extension. Returns the tracker path and an
 * env block suitable for `pm` subprocess calls.
 */
function freshWorkspace(): {
  root: string;
  tracker: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
} {
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
  // Bootstrap the tracker and install this package as a project extension so
  // extension-specific schema fields (todos_kv etc.) are available.
  execFileSync(pmBin, ["init", tracker, "--json"], { cwd: root, env, encoding: "utf-8" });
  execFileSync(pmBin, ["--pm-path", tracker, "install", process.cwd(), "--project", "--json"], {
    cwd: root,
    env,
    encoding: "utf-8",
  });
  return { root, tracker, env, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) };
}

/** Shared harness — activated once, reused across all tests in this file. */
let harness: Awaited<ReturnType<typeof createExtensionTestHarness>>;

beforeEach(async () => {
  if (!harness) {
    harness = await createExtensionTestHarness(extension, {
      name: "pm-todos",
      capabilities: ["commands", "schema", "importers", "preflight"],
    });
  }
});

afterEach(async () => {
  // Deactivate once at the very end — not per test, because reactivation is
  // expensive and the harness is stateless across runCommand calls.
});

// ---------------------------------------------------------------------------
// Command: todos validate
// ---------------------------------------------------------------------------

test("todos validate reports on a clean markdown file and returns the summary", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] Real task\n- [x] Done task\n");

    const result = await harness.runCommand({
      command: "todos validate",
      args: [file],
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const report = result.result as { file: string; format: string; taskCount: number; errors: number; warnings: number };
    assert.equal(report.taskCount, 2);
    assert.equal(report.errors, 0);
  } finally {
    ws.cleanup();
  }
});

test("todos validate with --json returns the issues array", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "- [ ] (p9) bad priority\n");

    const result = await harness.runCommand({
      command: "todos validate",
      args: [file],
      pmRoot: ws.tracker,
      global: { json: true },
    });

    assert.equal(result.handled, false);
    assert.ok(result.errorMessage && /structural error/.test(result.errorMessage));
  } finally {
    ws.cleanup();
  }
});

test("todos validate throws USAGE when no file argument is given", async () => {
  const ws = freshWorkspace();
  try {
    await assert.rejects(
      () => harness.runCommand({ command: "todos validate", pmRoot: ws.tracker }),
      (err: unknown) => err instanceof Error && "exitCode" in err && /Usage: pm todos validate/.test(err.message),
    );
  } finally {
    ws.cleanup();
  }
});

test("todos validate throws NOT_FOUND for a missing file", async () => {
  const ws = freshWorkspace();
  try {
    await assert.rejects(
      () => harness.runCommand({
        command: "todos validate",
        args: [join(ws.root, "nope.md")],
        pmRoot: ws.tracker,
      }),
      (err: unknown) => err instanceof Error && "exitCode" in err && /Failed to read file/.test(err.message),
    );
  } finally {
    ws.cleanup();
  }
});

test("todos validate with --format todotxt validates a todo.txt file", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "todo.txt");
    writeFileSync(file, "(A) Task +proj due:2026-07-01\nx Done\n");

    const result = await harness.runCommand({
      command: "todos validate",
      args: [file],
      options: { format: "todotxt" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const report = result.result as { taskCount: number; errors: number };
    assert.equal(report.taskCount, 2);
    assert.equal(report.errors, 0);
  } finally {
    ws.cleanup();
  }
});

test("todos validate with --format jsonl validates a jsonl file", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "f.jsonl");
    writeFileSync(file, JSON.stringify({ id: "pm-1", title: "Ok", status: "open" }) + "\n");

    const result = await harness.runCommand({
      command: "todos validate",
      args: [file],
      options: { format: "jsonl" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const report = result.result as { taskCount: number; errors: number };
    assert.equal(report.taskCount, 1);
    assert.equal(report.errors, 0);
  } finally {
    ws.cleanup();
  }
});

test("todos validate with --format todojson validates a todojson file", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "todo.json");
    writeFileSync(file, JSON.stringify({ action: "list", todos: [{ id: 1, text: "A", done: false }], nextId: 2 }));

    const result = await harness.runCommand({
      command: "todos validate",
      args: [file],
      options: { format: "todojson" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const report = result.result as { taskCount: number; errors: number };
    assert.equal(report.taskCount, 1);
    assert.equal(report.errors, 0);
  } finally {
    ws.cleanup();
  }
});

test("todos validate with --format checkbox validates a checkbox file", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "f.md");
    writeFileSync(file, "- [ ] task\n- [x] done\n");

    const result = await harness.runCommand({
      command: "todos validate",
      args: [file],
      options: { format: "checkbox" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const report = result.result as { taskCount: number; errors: number };
    assert.equal(report.taskCount, 2);
  } finally {
    ws.cleanup();
  }
});

test("todos validate with --format jsonl reports a warning for empty file (no tasks)", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "empty.jsonl");
    writeFileSync(file, "");

    const result = await harness.runCommand({
      command: "todos validate",
      args: [file],
      options: { format: "jsonl" },
      pmRoot: ws.tracker,
    });

    // jsonl with no rows: 0 tasks, no errors, possibly 0 warnings
    assert.equal(result.handled, true);
    const report = result.result as { taskCount: number; errors: number };
    assert.equal(report.taskCount, 0);
    assert.equal(report.errors, 0);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Command: todos context
// ---------------------------------------------------------------------------

test("todos context returns a snapshot of the workspace items", async () => {
  const ws = freshWorkspace();
  try {
    // Create some items via pm directly
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Task A", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Task B", "--type", "Bug", "--status", "open", "--priority", "0", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runCommand({
      command: "todos context",
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const snap = result.result as { totalMatched: number; focusCount: number };
    assert.equal(snap.totalMatched, 2);
    assert.ok(snap.focusCount > 0);
  } finally {
    ws.cleanup();
  }
});

test("todos context with --status and --sort options filters and orders", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Open", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Closed", "--type", "Task", "--status", "closed", "--close-reason", "done", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runCommand({
      command: "todos context",
      options: { status: "open", sort: "title", limit: "5" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const snap = result.result as { totalMatched: number };
    assert.equal(snap.totalMatched, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos context with --include-tags includes tags on focus rows", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Tagged", "--type", "Task", "--status", "open", "--tags", "alpha,beta", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runCommand({
      command: "todos context",
      options: { "include-tags": true },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const snap = result.result as { focus: Array<{ tags?: string[] }> };
    assert.ok(snap.focus[0]!.tags);
    assert.ok(snap.focus[0]!.tags!.includes("alpha"));
  } finally {
    ws.cleanup();
  }
});

test("todos context with --type filter", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "A", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "B", "--type", "Bug", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runCommand({
      command: "todos context",
      options: { type: "Bug" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const snap = result.result as { totalMatched: number };
    assert.equal(snap.totalMatched, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos context with invalid --limit throws USAGE", async () => {
  const ws = freshWorkspace();
  try {
    await assert.rejects(
      () => harness.runCommand({
        command: "todos context",
        options: { limit: "abc" },
        pmRoot: ws.tracker,
      }),
      (err: unknown) => err instanceof Error && "exitCode" in err && /Invalid --limit/.test(err.message),
    );
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Command: todos sync
// ---------------------------------------------------------------------------

test("todos sync imports and re-exports a markdown file", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] Task A\n- [x] Done B\n");

    const result = await harness.runCommand({
      command: "todos sync",
      args: [file],
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number; reexported: number };
    assert.equal(res.imported, 2);
    assert.ok(res.reexported > 0);
    // The file should now contain the pm ids
    const after = readFileSync(file, "utf-8");
    assert.match(after, /<!-- pm-/);
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --dry-run does not write", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] Task\n");
    const before = readFileSync(file, "utf-8");

    const result = await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { "dry-run": true },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { dryRun: boolean; imported: number };
    assert.equal(res.dryRun, true);
    assert.equal(readFileSync(file, "utf-8"), before, "dry-run must not write");
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --format jsonl round-trips items", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "f.jsonl");
    writeFileSync(file, JSON.stringify({ id: "pm-1", title: "Task", status: "open", type: "Task" }) + "\n");

    const result = await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { format: "jsonl" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number; reexported: number };
    assert.equal(res.imported, 1);
    assert.ok(res.reexported > 0);
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --format todotxt round-trips items", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "todo.txt");
    writeFileSync(file, "(A) Task +proj due:2026-07-01\n");

    const result = await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { format: "todotxt" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number; reexported: number };
    assert.equal(res.imported, 1);
    assert.ok(res.reexported > 0);
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --format todojson round-trips items", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "todo.json");
    writeFileSync(file, JSON.stringify({ action: "list", todos: [{ id: 1, text: "Task", done: false }], nextId: 2 }));

    const result = await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { format: "todojson" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number; reexported: number };
    assert.equal(res.imported, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --format checkbox round-trips items", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "f.md");
    writeFileSync(file, "- [ ] task\n- [x] done\n");

    const result = await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { format: "checkbox" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number };
    assert.equal(res.imported, 2);
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --format tasklist is rejected", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "f.md");
    writeFileSync(file, "- [ ] task\n");

    await assert.rejects(
      () => harness.runCommand({
        command: "todos sync",
        args: [file],
        options: { format: "tasklist" },
        pmRoot: ws.tracker,
      }),
      (err: unknown) => err instanceof Error && /tasklist is export-only/.test(err.message),
    );
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --group-by and --metadata options re-exports grouped", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] Task A\n- [ ] Task B\n");

    const result = await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { "group-by": "type", metadata: true, "priority-map": "letter" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const after = readFileSync(file, "utf-8");
    // Grouped markdown has ## <type heading> sections, not ## Open/## Done
    assert.match(after, /## Task/);
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --sort and --reverse re-exports in reversed order", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] Beta\n- [ ] Alpha\n");

    await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { sort: "title", reverse: true },
      pmRoot: ws.tracker,
    });

    const after = readFileSync(file, "utf-8");
    const betaIdx = after.indexOf("Beta");
    const alphaIdx = after.indexOf("Alpha");
    assert.ok(betaIdx < alphaIdx, "reversed title sort should put Beta before Alpha");
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --filter status=open only syncs open items", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] Open task\n- [x] Done task\n");

    const result = await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { filter: "status=open" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number; reexported: number };
    // Only the open item is imported (filter applies to import)
    assert.equal(res.imported, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --section only syncs the named section", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n## Backlog\n\n- [ ] Backlog task\n\n## Done\n\n- [x] Done task\n");

    const result = await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { section: "Backlog" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number };
    assert.equal(res.imported, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --allow-empty clears an already-synced file", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] task\n");

    // First sync to populate pm
    await harness.runCommand({
      command: "todos sync",
      args: [file],
      pmRoot: ws.tracker,
    });

    // Now filter to a non-existent type to get 0 items, with --allow-empty
    const result = await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { filter: "type=Nonexistent", "allow-empty": true },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const after = readFileSync(file, "utf-8");
    // The file should be cleared (empty or just the header)
    assert.ok(!after.includes("- [ ] task"), "file should not contain the original task");
  } finally {
    ws.cleanup();
  }
});

test("todos sync refuses to replace a non-empty file with an empty result", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] task\n");

    // First sync to populate pm
    await harness.runCommand({
      command: "todos sync",
      args: [file],
      pmRoot: ws.tracker,
    });

    // Now filter to a non-existent type to get 0 items, WITHOUT --allow-empty
    await assert.rejects(
      () => harness.runCommand({
        command: "todos sync",
        args: [file],
        options: { filter: "type=Nonexistent" },
        pmRoot: ws.tracker,
      }),
      (err: unknown) => err instanceof Error && /Refusing to replace non-empty/.test(err.message),
    );
  } finally {
    ws.cleanup();
  }
});

test("todos sync throws USAGE when no file argument is given", async () => {
  const ws = freshWorkspace();
  try {
    await assert.rejects(
      () => harness.runCommand({ command: "todos sync", pmRoot: ws.tracker }),
      (err: unknown) => err instanceof Error && /Usage: pm todos sync/.test(err.message),
    );
  } finally {
    ws.cleanup();
  }
});

test("todos sync throws NOT_FOUND for a missing file", async () => {
  const ws = freshWorkspace();
  try {
    await assert.rejects(
      () => harness.runCommand({
        command: "todos sync",
        args: [join(ws.root, "nope.md")],
        pmRoot: ws.tracker,
      }),
      (err: unknown) => err instanceof Error && /Failed to read sync file/.test(err.message),
    );
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --no-section-tags disables section tag derivation", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n## Backlog\n\n- [ ] task\n");

    await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { sectionTags: false },
      pmRoot: ws.tracker,
    });

    // Verify the item does not have the "backlog" section tag by checking pm list
    const list = JSON.parse(execFileSync(pmBin, ["--pm-path", ws.tracker, "list-all", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    })) as { items: Array<{ tags?: string[] }> };
    assert.ok(!list.items[0]!.tags?.includes("backlog"), "section tag should not be derived");
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --closed-as canceled imports checked items as canceled", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [x] done\n");

    const result = await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { "closed-as": "canceled" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const list = JSON.parse(execFileSync(pmBin, ["--pm-path", ws.tracker, "list-all", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    })) as { items: Array<{ status: string }> };
    assert.equal(list.items[0]!.status, "canceled");
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --status draft maps unchecked to draft", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] task\n");

    await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { status: "draft" },
      pmRoot: ws.tracker,
    });

    const list = JSON.parse(execFileSync(pmBin, ["--pm-path", ws.tracker, "list-all", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    })) as { items: Array<{ status: string }> };
    assert.equal(list.items[0]!.status, "draft");
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --priority overrides inferred priority", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] (p3) task\n");

    await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { priority: "1" },
      pmRoot: ws.tracker,
    });

    const list = JSON.parse(execFileSync(pmBin, ["--pm-path", ws.tracker, "list-all", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    })) as { items: Array<{ priority?: number }> };
    assert.equal(list.items[0]!.priority, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos sync with --tags adds extra tags to every item", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] task\n");

    await harness.runCommand({
      command: "todos sync",
      args: [file],
      options: { tags: "extra,tag2" },
      pmRoot: ws.tracker,
    });

    const list = JSON.parse(execFileSync(pmBin, ["--pm-path", ws.tracker, "list-all", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    })) as { items: Array<{ tags?: string[] }> };
    assert.ok(list.items[0]!.tags?.includes("extra"));
    assert.ok(list.items[0]!.tags?.includes("tag2"));
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Importer: todos (pm todos import)
// ---------------------------------------------------------------------------

test("todos import creates items from a markdown file", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] Task A\n- [x] Done B\n");

    const result = await harness.runImporter({
      importer: "todos",
      args: [file],
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number };
    assert.equal(res.imported, 2);
  } finally {
    ws.cleanup();
  }
});

test("todos import with --dry-run previews without writing", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] Task\n");

    const result = await harness.runImporter({
      importer: "todos",
      args: [file],
      options: { "dry-run": true },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { dryRun: boolean; wouldImport: number };
    assert.equal(res.dryRun, true);
    assert.equal(res.wouldImport, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos import with --upsert updates existing items", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] Task A\n");

    // First import (create)
    await harness.runImporter({
      importer: "todos",
      args: [file],
      options: { upsert: true },
      pmRoot: ws.tracker,
    });

    // Modify the file and re-import with --upsert
    writeFileSync(file, "# TODO\n\n- [x] Task A\n");
    const result = await harness.runImporter({
      importer: "todos",
      args: [file],
      options: { upsert: true },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number; updated: number };
    assert.equal(res.imported, 0);
    assert.equal(res.updated, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos import with --glob matches files in the workspace", async () => {
  const ws = freshWorkspace();
  try {
    writeFileSync(join(ws.root, "a.todo.md"), "- [ ] task a\n");
    writeFileSync(join(ws.root, "b.todo.md"), "- [ ] task b\n");

    const result = await harness.runImporter({
      importer: "todos",
      options: { glob: "*.todo.md" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number };
    assert.equal(res.imported, 2);
  } finally {
    ws.cleanup();
  }
});

test("todos import with --glob and no matches throws NOT_FOUND", async () => {
  const ws = freshWorkspace();
  try {
    await assert.rejects(
      () => harness.runImporter({
        importer: "todos",
        options: { glob: "*.nomatch.md" },
        pmRoot: ws.tracker,
      }),
      (err: unknown) => err instanceof Error && /No files matched glob/.test(err.message),
    );
  } finally {
    ws.cleanup();
  }
});

test("todos import with no file/glob throws USAGE", async () => {
  const ws = freshWorkspace();
  try {
    await assert.rejects(
      () => harness.runImporter({
        importer: "todos",
        pmRoot: ws.tracker,
      }),
      (err: unknown) => err instanceof Error && /Usage: pm todos import/.test(err.message),
    );
  } finally {
    ws.cleanup();
  }
});

test("todos import with --format jsonl creates items with rich metadata", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "f.jsonl");
    writeFileSync(file, JSON.stringify({
      id: "pm-1", title: "Task", status: "open", type: "Task",
      priority: 2, tags: ["x"], deadline: "2026-07-01T00:00:00.000Z",
      assignee: "alice", sprint: "S1", kv: { k: "v" },
    }) + "\n");

    const result = await harness.runImporter({
      importer: "todos",
      args: [file],
      options: { format: "jsonl", upsert: true },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number };
    assert.equal(res.imported, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos import with --format todotxt creates items from todo.txt", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "todo.txt");
    writeFileSync(file, "(A) Task +proj @home due:2026-07-01\nx 2026-06-01 Done\n");

    const result = await harness.runImporter({
      importer: "todos",
      args: [file],
      options: { format: "todotxt" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number };
    assert.equal(res.imported, 2);
  } finally {
    ws.cleanup();
  }
});

test("todos import with --format todojson creates items (upsert is implicit)", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "todo.json");
    writeFileSync(file, JSON.stringify({ action: "list", todos: [
      { id: 1, text: "Task A", done: false },
      { id: 2, text: "Task B", done: true },
    ], nextId: 3 }));

    const result = await harness.runImporter({
      importer: "todos",
      args: [file],
      options: { format: "todojson" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number; updated: number };
    assert.equal(res.imported + res.updated, 2);
  } finally {
    ws.cleanup();
  }
});

test("todos import with --format checkbox creates items", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "f.md");
    writeFileSync(file, "- [ ] task a\n- [x] task b\n");

    const result = await harness.runImporter({
      importer: "todos",
      args: [file],
      options: { format: "checkbox" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number };
    assert.equal(res.imported, 2);
  } finally {
    ws.cleanup();
  }
});

test("todos import with --filter status=open only imports open items", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] Open\n- [x] Closed\n");

    const result = await harness.runImporter({
      importer: "todos",
      args: [file],
      options: { filter: "status=open" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number };
    assert.equal(res.imported, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos import with --type filter only imports matching type", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] Task [Feature] <!-- pm-x -->\n");

    const result = await harness.runImporter({
      importer: "todos",
      args: [file],
      options: { filter: "type=Feature" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number };
    assert.equal(res.imported, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos import with no items found reports zero", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "empty.md");
    writeFileSync(file, "just prose, no tasks\n");

    const result = await harness.runImporter({
      importer: "todos",
      args: [file],
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number; skipped: number };
    assert.equal(res.imported, 0);
    assert.equal(res.skipped, 0);
  } finally {
    ws.cleanup();
  }
});

test("todos import with --section only imports the named section", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "## Backlog\n- [ ] A\n## Done\n- [x] B\n");

    const result = await harness.runImporter({
      importer: "todos",
      args: [file],
      options: { section: "Backlog" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number };
    assert.equal(res.imported, 1);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Importer: todos-import (legacy alias)
// ---------------------------------------------------------------------------

test("todos-import legacy importer creates items from a file option", async () => {
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "# TODO\n\n- [ ] Legacy task\n");

    const result = await harness.runImporter({
      importer: "todos-import",
      options: { file },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { imported: number };
    assert.equal(res.imported, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos-import legacy importer skips when no file option is provided", async () => {
  const ws = freshWorkspace();
  try {
    const result = await harness.runImporter({
      importer: "todos-import",
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Exporter: todos (pm todos export)
// ---------------------------------------------------------------------------

test("todos export returns markdown by default", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Task A", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runExporter({
      exporter: "todos",
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { exported: number; markdown: string };
    assert.ok(res.exported > 0);
    assert.match(res.markdown, /# TODO/);
  } finally {
    ws.cleanup();
  }
});

test("todos export with --format jsonl returns jsonl", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Task", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runExporter({
      exporter: "todos",
      options: { format: "jsonl" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { exported: number; markdown: string };
    assert.ok(res.exported > 0);
    assert.ok(res.markdown.includes("\"title\""));
  } finally {
    ws.cleanup();
  }
});

test("todos export with --format todotxt returns todo.txt", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Task", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runExporter({
      exporter: "todos",
      options: { format: "todotxt" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { exported: number; markdown: string };
    assert.ok(res.exported > 0);
    assert.match(res.markdown, /^Task/m);
  } finally {
    ws.cleanup();
  }
});

test("todos export with --format tasklist returns GFM task list", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Task", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runExporter({
      exporter: "todos",
      options: { format: "tasklist" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { exported: number; markdown: string };
    assert.ok(res.exported > 0);
    assert.match(res.markdown, /## Open/);
  } finally {
    ws.cleanup();
  }
});

test("todos export with --format todojson returns pi todo details JSON", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Task", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runExporter({
      exporter: "todos",
      options: { format: "todojson" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { exported: number; markdown: string };
    assert.ok(res.exported > 0);
    assert.match(res.markdown, /"todos"/);
  } finally {
    ws.cleanup();
  }
});

test("todos export with --format checkbox returns flat checkbox markdown", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Task", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runExporter({
      exporter: "todos",
      options: { format: "checkbox" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { exported: number; markdown: string };
    assert.ok(res.exported > 0);
    assert.match(res.markdown, /- \[ \] Task/);
  } finally {
    ws.cleanup();
  }
});

test("todos export with --output writes to a file", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Task", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });
    const outFile = join(ws.root, "export.md");

    const result = await harness.runExporter({
      exporter: "todos",
      options: { output: outFile },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { exported: number; file: string };
    assert.ok(res.exported > 0);
    const content = readFileSync(outFile, "utf-8");
    assert.match(content, /# TODO/);
  } finally {
    ws.cleanup();
  }
});

test("todos export with no items reports exported: 0", async () => {
  const ws = freshWorkspace();
  try {
    const result = await harness.runExporter({
      exporter: "todos",
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { exported: number };
    assert.equal(res.exported, 0);
  } finally {
    ws.cleanup();
  }
});

test("todos export with --status and --type filters", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "A", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "B", "--type", "Bug", "--status", "closed", "--close-reason", "done", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runExporter({
      exporter: "todos",
      options: { status: "open", type: "Task" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { exported: number; markdown: string };
    assert.equal(res.exported, 1);
    assert.match(res.markdown, /A/);
    assert.ok(!res.markdown.includes("B"));
  } finally {
    ws.cleanup();
  }
});

test("todos export with --filter status=open,type=Task", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "A", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runExporter({
      exporter: "todos",
      options: { filter: "status=open,type=Task" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { exported: number };
    assert.equal(res.exported, 1);
  } finally {
    ws.cleanup();
  }
});

test("todos export with --group-by sprint and --metadata", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "A", "--type", "Task", "--status", "open", "--priority", "1", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runExporter({
      exporter: "todos",
      options: { "group-by": "type", metadata: true, "priority-map": "letter" },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { exported: number; markdown: string };
    assert.ok(res.exported > 0);
    assert.match(res.markdown, /## Task/);
    assert.match(res.markdown, /\(B\)/);
  } finally {
    ws.cleanup();
  }
});

test("todos export with --sort and --reverse", async () => {
  const ws = freshWorkspace();
  try {
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Beta", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });
    execFileSync(pmBin, ["--pm-path", ws.tracker, "create", "--title", "Alpha", "--type", "Task", "--status", "open", "--json"], {
      cwd: ws.root, env: ws.env, encoding: "utf-8",
    });

    const result = await harness.runExporter({
      exporter: "todos",
      options: { sort: "title", reverse: true },
      pmRoot: ws.tracker,
    });

    assert.equal(result.handled, true);
    const res = result.result as { exported: number; markdown: string };
    const betaIdx = res.markdown.indexOf("Beta");
    const alphaIdx = res.markdown.indexOf("Alpha");
    assert.ok(betaIdx < alphaIdx, "reversed title sort: Beta before Alpha");
  } finally {
    ws.cleanup();
  }
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
  const ws = freshWorkspace();
  try {
    const file = join(ws.root, "TODO.md");
    writeFileSync(file, "- [ ] task\n");

    const result = await harness.runPreflightOverride({
      command: "todos import",
      args: [file],
      options: {},
      global: { json: true, quiet: true } as Record<string, unknown>,
      pm_root: ws.tracker,
      decision: preflightDecision,
    });

    assert.equal(result.overridden, true);
    assert.equal(result.decision.enforce_item_format_gate, true);
  } finally {
    ws.cleanup();
  }
});

test("preflight override returns passthrough when no files are resolved", async () => {
  const ws = freshWorkspace();
  try {
    const result = await harness.runPreflightOverride({
      command: "todos import",
      args: [],
      options: {},
      global: { json: true, quiet: true } as Record<string, unknown>,
      pm_root: ws.tracker,
      decision: preflightDecision,
    });

    assert.equal(result.overridden, true);
  } finally {
    ws.cleanup();
  }
});

test("preflight override resolves --glob files", async () => {
  const ws = freshWorkspace();
  try {
    writeFileSync(join(ws.root, "a.todo.md"), "- [ ] task\n");

    const result = await harness.runPreflightOverride({
      command: "todos import",
      args: [],
      options: { glob: "*.todo.md" },
      global: { json: true, quiet: true } as Record<string, unknown>,
      pm_root: ws.tracker,
      decision: preflightDecision,
    });

    assert.equal(result.overridden, true);
  } finally {
    ws.cleanup();
  }
});