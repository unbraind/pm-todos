/**
 * Regression coverage for issue #49: `pm todos import` silently dropped every
 * completed (`[x]`) item and exited 0, because it created each item directly in
 * a terminal status WITHOUT a close reason while `governance.require_close_reason`
 * is a built-in default. The completed record — the part a user cannot
 * reconstruct from what remains — vanished from the tracker while the file and
 * the exit code both reported success.
 *
 * These tests use a REAL pm workspace in a temp dir with DEFAULT settings
 * (no mocking of `require_close_reason`, since the default being on is the whole
 * point) and install THIS package from its source, exactly like the JSONL
 * integration test. The primary test MUST fail against the pre-fix code and pass
 * after; the dropped-line/exit-code tests pin the partial-import contract.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** The pm binary shipped with the installed dev dependency. */
const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");

/** One row of `pm list-all --json` output (only the fields these tests assert). */
interface ListItem {
  id: string;
  title: string;
  status: string;
}

/** The `pm list-all --json` collection envelope. */
interface ListAllResult {
  items: ListItem[];
}

/** The structured `dropped` entry the importer emits for a rejected source line. */
interface DroppedLine {
  file: string;
  line: number;
  title: string;
  reason: string;
}

/** The importer result object (subset asserted by these tests). */
interface ImportReceipt {
  imported: number;
  skipped: number;
  updated?: number;
  dropped?: DroppedLine[];
  exit_code?: number;
}

/** A single `pm get --json` item detail (only the fields these tests assert). */
interface ItemDetail {
  item: { id: string; status: string; close_reason?: string };
}

/** Captured result of one `pm` invocation. */
interface PmResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Build an isolated pm workspace in a fresh temp dir: a tracker, an isolated
 * HOME/global so no machine-local state leaks in, and THIS package installed as
 * a project extension. Returns a runner that invokes `pm` with `--json` and
 * captures stdout/stderr/exit status WITHOUT throwing on non-zero exit (the
 * dropped-import tests rely on reading a non-zero exit).
 */
function freshWorkspace(): {
  root: string;
  tracker: string;
  run: (args: string[]) => PmResult;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pm-todos-closereason-"));
  const tracker = join(root, "tracker");
  const home = join(root, "home");
  const xdgConfig = join(root, "xdg-config");
  const xdgData = join(root, "xdg-data");
  mkdirSync(home);
  mkdirSync(xdgConfig);
  mkdirSync(xdgData);
  const env = {
    ...process.env,
    HOME: home,
    PM_GLOBAL_PATH: join(root, "global-pm"),
    PM_TELEMETRY_DISABLED: "1",
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
  };
  const run = (args: string[]): PmResult => {
    const result = spawnSync(pmBin, args, { cwd: root, env, encoding: "utf-8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  // Bootstrap the tracker and install this package as a project extension.
  // The package is installed from its own source (process.cwd()), so the test
  // exercises the code in this repository, not a stale published build.
  assert.equal(run(["init", tracker, "--json"]).status, 0, "pm init must succeed");
  assert.equal(
    run(["--pm-path", tracker, "install", process.cwd(), "--project", "--json"]).status,
    0,
    "pm install of this package must succeed",
  );
  return { root, tracker, run, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) };
}

/** Parse the JSON receipt the importer writes to stdout under `--json`. */
function parseReceipt(out: string): ImportReceipt {
  return JSON.parse(out) as ImportReceipt;
}

test("import creates the completed [x] item (issue #49 regression)", () => {
  // This is the exact reproduction shape from the issue: a normal TODO file
  // with one finished [x] line and one pending [ ] line, imported into a
  // default workspace. Before the fix, "Finished work that must not be lost"
  // was never created and the command exited 0. After the fix, the closed item
  // lands with a traceable close reason.
  const ws = freshWorkspace();
  try {
    const todo = join(ws.root, "TODO.md");
    writeFileSync(todo, "# TODO\n\n- [x] Finished work that must not be lost\n- [ ] Pending work\n");

    const imp = ws.run(["--pm-path", ws.tracker, "todos", "import", todo, "--json"]);
    assert.equal(imp.status, 0, `import must exit 0 on a clean file; stderr:\n${imp.stderr}`);
    const receipt = parseReceipt(imp.stdout);
    assert.equal(receipt.imported, 2, "both the completed and pending items must be imported");
    assert.equal(receipt.skipped, 0, "no items may be dropped on a clean import");

    const list = JSON.parse(ws.run(["--pm-path", ws.tracker, "list-all", "--json"]).stdout) as ListAllResult;
    const titles = new Map(list.items.map((i) => [i.title, i] as const));
    assert.ok(titles.has("Finished work that must not be lost"), "the completed item must exist in the tracker");
    assert.equal(titles.get("Pending work")?.status, "open", "the pending item must be open");
    assert.equal(
      titles.get("Finished work that must not be lost")?.status,
      "closed",
      "the completed item must be closed, not dropped",
    );

    // The close reason is the immutable closure evidence; it must name the
    // source provenance so the closure is traceable, not invented.
    const closedId = titles.get("Finished work that must not be lost")!.id;
    const detail = JSON.parse(
      ws.run(["--pm-path", ws.tracker, "get", closedId, "--json"]).stdout,
    ) as ItemDetail;
    const closeReason = detail.item?.close_reason;
    assert.ok(
      typeof closeReason === "string" && closeReason.includes("Imported as closed"),
      `close_reason must carry import provenance; got: ${closeReason}`,
    );
    assert.ok(
      closeReason.includes("TODO.md") && closeReason.includes("line 3"),
      `close_reason must name the source file and line; got: ${closeReason}`,
    );
  } finally {
    ws.cleanup();
  }
});

test("a partial import reports every dropped line on the normal output path and exits non-zero", () => {
  // Force a per-line create failure that PASSES the up-front syntax preflight
  // but is rejected by `pm create` at write time: two jsonl rows claiming the
  // SAME explicit `id`. Preflight validates structure (title/deadline/priority)
  // but not duplicate ids, so the first row is created and the second is
  // rejected by pm — the exact "partial import" shape issue #49 is about.
  const ws = freshWorkspace();
  try {
    const input = join(ws.root, "dup.jsonl");
    writeFileSync(input, '{"id":"pm-dup1","title":"First item","status":"open"}\n{"id":"pm-dup1","title":"Duplicate id item","status":"open"}\n');

    const imp = ws.run(["--pm-path", ws.tracker, "todos", "import", input, "--format", "jsonl", "--json"]);
    // The contract: a partial import must NOT exit 0.
    assert.notEqual(imp.status, 0, "a partial import must exit non-zero");
    assert.equal(imp.status, 1, "the exit code is the generic failure code (1)");

    // The per-line failure reaches the NORMAL output path (stdout JSON), not
    // only stderr. The `dropped` array names every lost line with its file,
    // line, title, and the pm error that rejected it.
    const receipt = parseReceipt(imp.stdout);
    assert.equal(receipt.imported, 1, "the valid line still lands (best-effort import)");
    assert.equal(receipt.skipped, 1, "skipped counts the dropped line");
    assert.ok(Array.isArray(receipt.dropped), "the result must carry a dropped array");
    assert.equal(receipt.dropped!.length, 1, "exactly the rejected line is reported");
    const dropped = receipt.dropped![0];
    assert.equal(dropped.line, 2, "the dropped entry names the source line");
    assert.equal(dropped.title, "Duplicate id item", "the dropped entry names the title");
    assert.ok(
      typeof dropped.reason === "string" && dropped.reason.length > 0,
      "the dropped entry carries the pm rejection reason",
    );
    assert.ok(dropped.file.includes("dup.jsonl"), "the dropped entry names the source file");
  } finally {
    ws.cleanup();
  }
});

test("import of an all-completed file closes every item and exits 0", () => {
  // A file where EVERY line is checked is the issue's "normal case" (a TODO
  // file with no [ ] lines is the unusual one). Every line must close with a
  // reason and the command must succeed.
  const ws = freshWorkspace();
  try {
    const todo = join(ws.root, "all-done.md");
    writeFileSync(todo, "# TODO\n\n- [x] Shipped feature A\n- [x] Shipped feature B\n");
    const imp = ws.run(["--pm-path", ws.tracker, "todos", "import", todo, "--json"]);
    assert.equal(imp.status, 0, `all-completed import must exit 0; stderr:\n${imp.stderr}`);
    const receipt = parseReceipt(imp.stdout);
    assert.equal(receipt.imported, 2);
    assert.equal(receipt.skipped, 0);
    const list = JSON.parse(ws.run(["--pm-path", ws.tracker, "list-all", "--json"]).stdout) as ListAllResult;
    assert.equal(list.items.length, 2, "both completed items must be in the tracker");
    assert.ok(
      list.items.every((i) => i.status === "closed"),
      "every imported item must be closed",
    );
  } finally {
    ws.cleanup();
  }
});

test("todos sync does not overwrite the source file when an import line drops", () => {
  // sync re-exports pm state back over the source file. If the import half
  // drops a line, re-exporting would SILENTLY DELETE that line from the file —
  // the same data loss issue #49 describes, on the sync path. The fix refuses
  // the write, reports every dropped line on the normal output path, and exits
  // non-zero so the original file bytes (still carrying the dropped lines)
  // survive for the user to fix and re-run.
  //
  // The drop is forced with `--type UnknownType`: the up-front preflight
  // validates source structure (not the pm type vocabulary), so the lines pass
  // the gate, then `pm create --type UnknownType` rejects every row at write
  // time — a deterministic per-line failure that does not depend on close-reason
  // behaviour.
  const ws = freshWorkspace();
  try {
    const input = join(ws.root, "sync.md");
    writeFileSync(input, "# TODO\n\n- [ ] One\n- [ ] Two\n");
    const before = readFileSync(input, "utf-8");

    const res = ws.run(["--pm-path", ws.tracker, "todos", "sync", input, "--type", "UnknownType", "--json"]);
    assert.notEqual(res.status, 0, "sync that drops a line must exit non-zero");

    // The structured result carries the dropped report on the normal output
    // path (stdout JSON), not only stderr.
    const receipt = parseReceipt(res.stdout);
    assert.ok(Array.isArray(receipt.dropped) && receipt.dropped!.length === 2, "sync must report every dropped line");
    assert.equal(receipt.dropped![0].title, "One");
    assert.equal(receipt.dropped![1].title, "Two");

    // The source file must be byte-identical to its pre-sync content — sync
    // must NOT have overwritten it with the (empty) partial pm state.
    const after = readFileSync(input, "utf-8");
    assert.equal(after, before, "sync must not overwrite the file when it dropped a line");
  } finally {
    ws.cleanup();
  }
});