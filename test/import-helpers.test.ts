/**
 * In-process unit coverage for the issue #49 import helpers.
 *
 * The end-to-end regression in `import-close-reason.test.ts` drives the FULL
 * command through a real `pm` subprocess, which proves the behaviour a user sees
 * but contributes no line/branch/function coverage to `index.ts` (the code runs
 * in a child process, outside this runner's V8 counters). These helpers are the
 * pure, decision-bearing core of that fix — which status counts as terminal,
 * what close reason a checked line carries, and how a partial-import result is
 * shaped — so they are imported directly and exercised branch-for-branch here.
 * This is what keeps the package's coverage gate honest about the new code
 * rather than blind to it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildImportCloseReason, isTerminalStatus, withDroppedReport } from "../index.ts";

/**
 * One dropped-line record in the shape `runTodoImport` pushes when a pm
 * create/update rejects a source line. Built locally because `DroppedTodoLine`
 * is an internal type; the object is structurally identical to what the
 * importer emits, which is all `withDroppedReport` requires.
 */
function sampleDroppedLine(): { file: string; line: number; title: string; reason: string } {
  return { file: "TODO.md", line: 3, title: "Finished work that must not be lost", reason: "rejected" };
}

test("isTerminalStatus is true only for closed and canceled", () => {
  // Both terminal pm statuses map to a checked import box and so need a close
  // reason; any other status is left alone. Exercising both true arms and a
  // false arm covers every branch of the `||`.
  assert.equal(isTerminalStatus("closed"), true);
  assert.equal(isTerminalStatus("canceled"), true);
  assert.equal(isTerminalStatus("open"), false);
  assert.equal(isTerminalStatus("in_progress"), false);
});

test("buildImportCloseReason names the status, source file, and line", () => {
  // With a real source file the reason traces back to the originating TODO line.
  assert.equal(
    buildImportCloseReason("closed", "TODO.md", 3),
    "Imported as closed from TODO.md line 3",
  );
  // A missing file (stdin import) falls back to the literal "stdin" provenance.
  assert.equal(
    buildImportCloseReason("canceled", undefined, 7),
    "Imported as canceled from stdin line 7",
  );
});

test("withDroppedReport leaves a clean result and the exit code untouched", () => {
  // No dropped line means success: the base result is returned verbatim and the
  // process exit code is not touched, so a clean import still exits 0.
  const before = process.exitCode;
  try {
    const base = { imported: 2, skipped: 0 };
    const out = withDroppedReport(base, []);
    assert.deepEqual(out, base);
    assert.equal(process.exitCode, before, "a clean import must not set a failure exit code");
  } finally {
    process.exitCode = before;
  }
});

test("withDroppedReport attaches the dropped report and a non-zero exit code", () => {
  // A dropped line means a partial import: the per-line report and a non-zero
  // exit_code ride the structured result (the normal output path) and the
  // process exit code is set directly so the command fails.
  const before = process.exitCode;
  try {
    const base = { imported: 1, skipped: 1 };
    const dropped = [sampleDroppedLine()];
    // The helper's static return type is `T` (the base shape) so the
    // runtime-added `dropped`/`exit_code` fields are invisible to the checker;
    // widen through `unknown` to assert them without resorting to `any`.
    const out = withDroppedReport(base, dropped) as unknown as {
      imported: number;
      skipped: number;
      dropped: typeof dropped;
      exit_code: number;
    };
    assert.equal(out.imported, 1);
    assert.equal(out.skipped, 1);
    assert.deepEqual(out.dropped, dropped);
    assert.equal(out.exit_code, 1);
    assert.equal(process.exitCode, 1, "a partial import must set a non-zero process exit code");
  } finally {
    // Restore the runner's prior exit code so this assertion never leaks a
    // failure status into the surrounding test process.
    process.exitCode = before;
  }
});
