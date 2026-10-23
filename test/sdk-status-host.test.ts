/** Real workspace lifecycle and host-bound transport regressions, without git. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PmClient, createExtensionCommandSdk, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { isTerminalStatus, serializeTodoTxt, serializePiTodoDetails, renderDefaultMarkdown, renderGroupedMarkdown, renderTaskList, renderCheckboxMarkdown } from "../index.ts";
import { packExtension } from "./packed-fixture.ts";

/** Initialize and install the actual packed extension in an isolated plain directory. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "todos-sdk-host-"));
  const pmRoot = join(root, "tracker");
  const nodeOnly = join(root, "bin");
  mkdirSync(nodeOnly);
  copyFileSync(process.execPath, join(nodeOnly, basename(process.execPath)));
  const env = {
    ...process.env, PM_PATH: pmRoot, PM_AUTHOR: "host-author", HOME: root,
    PM_GLOBAL_PATH: join(root, "global"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    PM_TELEMETRY_DISABLED: "1", GIT_CEILING_DIRECTORIES: dirname(root),
  };
  const childMarker = join(root, "pm-child-attempt");
  const preload = join(root, "observe-child.mjs");
  writeFileSync(preload, `import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
const spawnSync = cp.spawnSync;
cp.spawnSync = function(command, argv, ...args) {
  const isPm = /^pm(?:\\.cmd)?$/u.test(basename(String(command))) || (Array.isArray(argv) && argv.some(arg => basename(String(arg)) === "cli.js" && String(arg).includes("pm-cli")));
  if (isPm) writeFileSync(${JSON.stringify(childMarker)}, "attempted");
  return spawnSync.call(this, command, argv, ...args);
};
syncBuiltinESMExports();`);
  const cli = join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  /** Launch the installed host directly; extension operations have no pm or git on PATH. */
  const pm = (args: string[], restricted = true): Record<string, unknown> => JSON.parse(execFileSync(process.execPath, ["--import", preload, cli, "--pm-path", pmRoot, ...args, "--json"], {
    cwd: root, encoding: "utf8", env: { ...env, ...(restricted ? { PATH: nodeOnly } : {}) },
  })) as Record<string, unknown>;
  pm(["init", "--prefix", "fixture", "--defaults", "--agent-guidance", "skip"], false);
  pm(["package", "install", packExtension(root), "--project"], false);
  return { root, pmRoot, nodeOnly, pm, childMarker, client: new PmClient({ pmRoot, cwd: root, author: "bound-author" }) };
}

test("F04: configured terminal-done roles govern every TODO converter", async t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  await f.client.schemaAddStatus("accepted", { role: ["terminal", "terminal_done"] });
  await f.client.schemaAddStatus("reviewing", { role: ["active"] });
  const registry = resolveRuntimeStatusRegistry((await readSettings(f.pmRoot)).schema);
  const accepted = (await f.client.create({ title: "Accepted fixture", type: "Task", status: "accepted", closeReason: "Reviewed fixture" })).item;
  const reviewing = (await f.client.create({ title: "Review fixture", type: "Task", status: "reviewing" })).item;
  const items = [accepted, reviewing];
  for (const text of [renderDefaultMarkdown(items, "fixed", false, "number", registry), renderGroupedMarkdown(items, "type", "fixed", false, "number", registry), renderTaskList(items, "status", false, "number", registry), renderCheckboxMarkdown(items, false, "number", registry)]) {
    assert.match(text, /- \[x\] Accepted fixture/u);
    assert.match(text, /- \[ \] Review fixture/u);
  }
  assert.match(serializeTodoTxt(items, "tags", registry), /^x .*Accepted fixture/mu);
  assert.equal(JSON.parse(serializePiTodoDetails(items, registry)).todos.find((row: { text: string }) => row.text === "Accepted fixture").done, true);
  assert.equal(isTerminalStatus("accepted", registry), true);
});

test("F04: custom default-close imports and upserts retain required close evidence", async t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  await f.client.schemaAddStatus("accepted", { role: ["terminal", "terminal_done"] });
  // The SDK governs closure evidence through the configured default-close role.
  const workflowFile = join(f.pmRoot, "schema", "workflows.json");
  const workflow = JSON.parse(readFileSync(workflowFile, "utf8")) as { workflow: { close_status: string } };
  workflow.workflow.close_status = "accepted";
  writeFileSync(workflowFile, JSON.stringify(workflow));
  const schemaFile = join(f.pmRoot, "schema", "statuses.json");
  const schema = JSON.parse(readFileSync(schemaFile, "utf8")) as { statuses: Array<{ id: string; roles: string[] }> };
  for (const status of schema.statuses) {
    status.roles = status.roles.filter(role => role !== "default_close");
    if (status.id === "accepted") status.roles.push("default_close");
  }
  writeFileSync(schemaFile, JSON.stringify(schema));
  const reviewing = (await f.client.create({ title: "Review fixture", type: "Task", status: "open" })).item;
  const input = join(f.root, "complete.md");
  writeFileSync(input, "- [x] Completed source\n");
  assert.equal(f.pm(["todos", "import", input, "--closed-as", "accepted"]).imported, 1);
  const completed = (await f.client.listAllComplete({ includeBody: true })).items.find(row => row.title === "Completed source");
  assert.equal(completed?.status, "accepted");
  assert.match(readFileSync(join(f.pmRoot, "history", `${completed!.id}.jsonl`), "utf8"), /Imported as accepted .*line 1/u);
  const output = join(f.root, "completed.md");
  f.pm(["todos", "export", "--output", output]);
  assert.match(readFileSync(output, "utf8"), /- \[x\] Completed source/u);
  // Upsert transitions also need closure evidence for the configured terminal role.
  writeFileSync(input, `- [x] Review fixture <!-- ${reviewing.id} -->\n`);
  assert.equal(f.pm(["todos", "import", input, "--upsert", "--closed-as", "accepted"]).updated, 1);
  assert.equal((await f.client.get(reviewing.id)).item.status, "accepted");
});

test("F09: packed import/export/upsert preserve metadata and author without pm or git on PATH", async t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const input = join(f.root, "input.jsonl"), output = join(f.root, "output.jsonl");
  const source = { id: "fixture-source-one", title: "Host transport fixture", status: "open", type: "Task", description: "Source body", kv: { rec: "1w", unicode: "é" }, creationDate: "2026-10-01", created_at: "2026-10-01T00:00:00.000Z" };
  writeFileSync(input, JSON.stringify(source) + "\n");
  assert.equal(f.pm(["todos", "import", input, "--format", "jsonl", "--upsert"]).imported, 1);
  writeFileSync(input, JSON.stringify({ ...source, title: "Updated host fixture" }) + "\n");
  assert.equal(f.pm(["todos", "import", input, "--format", "jsonl", "--upsert"]).updated, 1);
  assert.equal(f.pm(["todos", "export", "--format", "jsonl", "--output", output]).exported, 1);
  assert.equal(existsSync(f.childMarker), false, "TODO operations must not launch a child pm process");
  const row = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(row.title, "Updated host fixture");
  assert.equal(row.description, source.description);
  assert.deepEqual(row.kv, source.kv);
  assert.equal(row.creationDate, source.creationDate);
  assert.equal(row.created_at, source.created_at);
  const stored = (await f.client.listAllComplete()).items[0]!;
  const history = readFileSync(join(f.pmRoot, "history", `${stored.id}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line) as { author: string });
  assert.ok(history.every(event => event.author === stored.author));
  // A supplied client must win over environment attribution and local resolution.
  writeFileSync(input, JSON.stringify({ ...source, title: "Bound client fixture" }) + "\n");
  const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
  t.after(() => harness.deactivate());
  const previousPath = process.env.PATH;
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(f.root);
  process.env.PATH = f.nodeOnly;
  try {
    const result = await harness.runCommand({ command: "todos sync", args: [input], pmRoot: f.pmRoot, options: { format: "jsonl" }, sdk: createExtensionCommandSdk(f.pmRoot, f.client, "bound-author") });
    assert.equal((result.result as Record<string, unknown>).updated, 1);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  }
  const finalHistory = readFileSync(join(f.pmRoot, "history", `${stored.id}.jsonl`), "utf8").trim().split("\n");
  assert.equal((JSON.parse(finalHistory.at(-1)!) as { author: string }).author, "bound-author");
});
