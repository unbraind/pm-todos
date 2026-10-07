/** Fidelity properties for the public conversion and real persisted tracker. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { parseTodoTxtLine, serializeTodoTxtLine, serializeTodoTxt, todoTxtItemToPm } from "../index.ts";
import { packExtension } from "./packed-fixture.ts";

/** Generate reproducible combinations across the captured todo.txt grammar. */
function generatedLines(): string[] {
  const lines: string[] = [];
  for (let i = 0; i < 312; i++) {
    const done = i % 2 === 0;
    const priority = i % 3 === 0 ? "" : `(${String.fromCharCode(65 + i % 26)}) `;
    const creation = i % 4 === 0 ? "" : "2026-10-01 ";
    const prefix = done ? "x 2026-10-02 " : "";
    const tokens = [`Task${i}`, "+Shared", "@Shared", "世界🧠", "@téléphone", "+研究", "rec:1w", "due:2026-11-01", "owner:Zoë", "+Shared", "@Shared"];
    const shift = i % tokens.length;
    const body = [...tokens.slice(shift), ...tokens.slice(0, shift)].join(i % 5 === 0 ? "\t" : " ");
    lines.push(`${prefix}${priority}${creation}${body}`);
  }
  return lines;
}

test("fidelity SDK round-trips generated priorities, dates, ordered tokens and unicode", () => {
  for (const line of generatedLines()) {
    const parsed = parseTodoTxtLine(line);
    assert.ok(parsed);
    const mapped = todoTxtItemToPm(parsed, "", "fidelity");
    const exported = serializeTodoTxtLine(mapped, "fidelity");
    assert.equal(exported, line.replace(/\s+/g, " "), line);
    assert.deepEqual(parseTodoTxtLine(exported), { ...parsed, raw: exported }, line);
    assert.equal(serializeTodoTxt([mapped], "fidelity"), `${exported}\n`);
  }
  assert.equal(serializeTodoTxt([], "fidelity"), "");
});

test("tags mapping remains explicit and generic tags still become projects", () => {
  const parsed = parseTodoTxtLine("(Z) Task +x @x @ctx");
  assert.ok(parsed);
  assert.equal(serializeTodoTxtLine(todoTxtItemToPm(parsed)), "(E) Task +x +x +ctx");
  assert.equal(serializeTodoTxtLine(todoTxtItemToPm(parsed, "", "fidelity")), "(E) Task +x +x +ctx");
  assert.equal(serializeTodoTxtLine({ id: "", title: "Generic", status: "open", tags: ["plain"] }, "fidelity"), "Generic +plain");
});

test("fidelity reflects edits to title, tags, priority, deadline and key:value fields", () => {
  const parsed = parseTodoTxtLine("(Z) Task @ctx +x rec:1w due:2026-11-01 owner:Zoë");
  assert.ok(parsed);
  const mapped = todoTxtItemToPm(parsed, "", "fidelity");
  assert.equal(serializeTodoTxtLine({ ...mapped, title: "Edited task", priority: 0, tags: ["ctx", "new"], deadline: "2026-12-01", kv: { rec: "2w", extra: "✓" } }, "fidelity"), "(A) Edited task @ctx rec:2w due:2026-12-01 +new extra:✓");
  assert.equal(serializeTodoTxtLine({ ...mapped, tags: [], deadline: undefined, kv: undefined, priority: undefined }, "fidelity"), "Task");
});

test("fidelity persists through installed CLI import/export/upsert/sync with real SDK", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-todos-fidelity-"));
  const tracker = join(root, "tracker");
  const input = join(root, "todo.txt");
  const output = join(root, "export.txt");
  const home = join(root, "home");
  mkdirSync(home);
  const env = { ...process.env, HOME: home, PM_GLOBAL_PATH: join(root, "global"), PM_TELEMETRY_DISABLED: "1", XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data") };
  const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");
  /** Run the installed package against a disposable tracker, outside the repo. */
  const runPm = (args: string[]): string => execFileSync(pmBin, args, { cwd: root, env, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  try {
    runPm(["init", tracker, "--json"]);
    runPm(["--pm-path", tracker, "package", "install", packExtension(root), "--project", "--json"]);
    const source = ["(Z) 2026-10-01 Open @Shared +Shared @téléphone rec:1w +研究 due:2026-11-01", "x 2026-10-02 (B) 2026-10-01 Done +研究 @Shared +Shared @Shared owner:Zoë", "Undecorated +x @x"];
    writeFileSync(input, `${source.join("\n")}\n`);
    const result = JSON.parse(runPm(["--pm-path", tracker, "todos", "import", input, "--format", "todotxt", "--todotxt-mapping", "fidelity", "--json"])) as { imported: number; skipped: number };
    assert.equal(result.imported, 3);
    assert.equal(result.skipped, 0);
    runPm(["--pm-path", tracker, "todos", "export", "--format", "todotxt", "--todotxt-mapping", "fidelity", "--output", output, "--json"]);
    assert.deepEqual(readFileSync(output, "utf-8").trim().split("\n").sort(), [...source].sort());
    runPm(["--pm-path", tracker, "todos", "sync", input, "--format", "todotxt", "--todotxt-mapping", "fidelity", "--json"]);
    assert.deepEqual(readFileSync(input, "utf-8").trim().split("\n").sort(), [...source].sort());

    // Exercise current source handlers in-process for coverage, still writing
    // through the real installed SDK/CLI with no mocks.
    const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
    const imported = await harness.runImporter({ importer: "todos", args: [input], options: { format: "todotxt", todotxtMapping: "fidelity", upsert: true }, pmRoot: tracker });
    assert.equal((imported.result as { updated: number }).updated, 3);
    const exported = await harness.runExporter({ exporter: "todos", options: { format: "todotxt", todotxtMapping: "fidelity" }, pmRoot: tracker });
    const data = exported.result as { markdown: string };
    assert.deepEqual(data.markdown.trim().split("\n").sort(), [...source].sort());
    const markdown = await harness.runExporter({ exporter: "todos", options: {}, pmRoot: tracker });
    assert.doesNotMatch((markdown.result as { markdown: string }).markdown, /@Shared|\+研究|rec:1w|todos_todotxt/);
    await assert.rejects(harness.runExporter({ exporter: "todos", options: { format: "todotxt", "todotxt-mapping": "invalid" }, pmRoot: tracker }), /expected tags\|fidelity/);

    // Replacing fidelity input removes obsolete provenance/date/kv fields.
    writeFileSync(input, "Open @ctx\nDone +x\n");
    const updated = await harness.runImporter({ importer: "todos", args: [input], options: { format: "todotxt", "todotxt-mapping": "fidelity", upsert: true }, pmRoot: tracker });
    assert.equal((updated.result as { updated: number }).updated, 2);
    const fresh = await harness.runExporter({ exporter: "todos", options: { format: "todotxt", "todotxt-mapping": "fidelity" }, pmRoot: tracker });
    assert.deepEqual((fresh.result as { markdown: string }).markdown.trim().split("\n").sort(), ["Done +x", "Open @ctx", "Undecorated +x @x"]);
    const legacy = await harness.runImporter({ importer: "todos", args: [input], options: { format: "todotxt", upsert: true }, pmRoot: tracker });
    assert.equal((legacy.result as { updated: number }).updated, 2);
    const folded = await harness.runExporter({ exporter: "todos", options: { format: "todotxt", "todotxt-mapping": "fidelity" }, pmRoot: tracker });
    assert.doesNotMatch((folded.result as { markdown: string }).markdown, /@ctx/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
