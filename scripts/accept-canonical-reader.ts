import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, { COMPLETE_LIST_COMMAND_ARGUMENTS } from "../index.ts";

/** Complete response emitted by the fake host for every whole-tracker read. */
function completeEnvelope(): Record<string, unknown> {
  return {
    items: [{ id: "fixture-1", title: "Tracked TODO", status: "open" }],
    count: 1,
    total: 1,
    has_more: false,
    truncated: false,
    next_cursor: null,
    filters: { status: "all", include_body: true, no_truncate: true, strict_read: true, runtime_filters: {} },
    limit: null,
    requested_limit: null,
    effective_limit: null,
    source: null,
    completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
    projection: { mode: "full", fields: null },
    omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] },
    read_output: {
      contract_version: 1,
      command: "list",
      requested_dimensions: ["include", "amount", "cost"],
      within_budget: true,
      strings_compacted: false,
      rows_compacted: false,
      result_omitted: false,
    },
  };
}

test("canonical reader acceptance: upsert and export each issue exactly one complete-list read", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-todos-canonical-reader-"));
  const fakePmScript = join(root, "fake-pm.mjs");
  const fakePm = join(root, process.platform === "win32" ? "pm.cmd" : "pm");
  const argsFile = join(root, "args.jsonl");
  const input = join(root, "TODO.md");
  const previousPath = process.env.PATH;
  const previousResponse = process.env.PM_TODOS_FAKE_RESPONSE;
  const previousArgsFile = process.env.PM_TODOS_ARGS_FILE;
  writeFileSync(input, "# TODO\n\n- [ ] Tracked TODO\n", "utf8");
  writeFileSync(fakePmScript, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.PM_TODOS_ARGS_FILE, JSON.stringify(args) + "\\n");
process.stdout.write(args.includes("list") ? process.env.PM_TODOS_FAKE_RESPONSE : '{"item":{"id":"fixture-1"}}');
`, "utf8");
  if (process.platform === "win32") {
    writeFileSync(fakePm, '@node "%~dp0\\fake-pm.mjs" %*\r\n', "utf8");
  } else {
    writeFileSync(fakePm, readFileSync(fakePmScript, "utf8"), "utf8");
    chmodSync(fakePm, 0o755);
  }
  process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`;
  process.env.PM_TODOS_FAKE_RESPONSE = JSON.stringify(completeEnvelope());
  process.env.PM_TODOS_ARGS_FILE = argsFile;

  const harness = await createExtensionTestHarness(extension, {
    name: "pm-todos",
    capabilities: ["commands", "schema", "importers", "preflight"],
  });
  try {
    const exported = await harness.runExporter({ exporter: "todos", pmRoot: "/tracker", options: { format: "jsonl" } });
    assert.equal((exported.result as Record<string, unknown>).exported, 1);
    const imported = await harness.runImporter({
      importer: "todos",
      pmRoot: "/tracker",
      options: { file: input, format: "markdown", upsert: true },
    });
    assert.equal((imported.result as Record<string, unknown>).updated, 1);
    const invocations = readFileSync(argsFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const reads = invocations.filter((args) => args.includes("list"));
    assert.equal(reads.length, 2, "one read is required for export and one for upsert import");
    for (const args of reads) {
      assert.deepEqual(args, ["--pm-path", "/tracker", ...COMPLETE_LIST_COMMAND_ARGUMENTS]);
    }
  } finally {
    await harness.deactivate();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousResponse === undefined) delete process.env.PM_TODOS_FAKE_RESPONSE;
    else process.env.PM_TODOS_FAKE_RESPONSE = previousResponse;
    if (previousArgsFile === undefined) delete process.env.PM_TODOS_ARGS_FILE;
    else process.env.PM_TODOS_ARGS_FILE = previousArgsFile;
    rmSync(root, { recursive: true, force: true });
  }
});
