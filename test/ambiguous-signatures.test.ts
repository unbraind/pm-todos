/** Real tracker regressions for title collisions that previously erased sync rows. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after } from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { COMPLETE_LIST_COMMAND_ARGUMENTS } from "../index.ts";
import { packExtension } from "./packed-fixture.ts";

/** Capture every tracker file's relative name and bytes, including audit history. */
function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[path.slice(directory.length + 1)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  return files;
}

/** Install the built artifact and isolate public CLI and source-handler calls. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "pm-todos-signatures-"));
  const tracker = join(root, "tracker");
  const home = join(root, "home");
  mkdirSync(home);
  const env = { ...process.env, HOME: home, PM_GLOBAL_PATH: join(root, "global"), PM_TELEMETRY_DISABLED: "1", XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data") };
  const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");
  /** Capture refusal status and diagnostics without swallowing process failures. */
  const run = (args: string[]) => {
    const result = spawnSync(pmBin, args, { cwd: root, env, encoding: "utf8" });
    assert.ifError(result.error);
    return result;
  };
  assert.equal(run(["init", tracker, "--json"]).status, 0);
  assert.equal(run(["--pm-path", tracker, "package", "install", packExtension(root), "--project", "--json"]).status, 0);
  /** Invoke a public command against the fixture's tracker. */
  const pm = (args: string[]) => run(["--pm-path", tracker, ...args, "--json"]);
  return { root, tracker, pm };
}

// Both the public CLI and source harness relaunch this pinned host via PATH.
const originalPath = process.env.PATH;
process.env.PATH = `${join(process.cwd(), "node_modules", ".bin")}${delimiter}${originalPath ?? ""}`;
after(() => { process.env.PATH = originalPath; });

const formats = [
  { format: "todotxt", mapping: "tags", name: "todo.txt", rows: ["Task +one", "Task @two"], unique: "Unique +safe" },
  { format: "todotxt", mapping: "fidelity", name: "todo.txt", rows: ["Task +one", "Task @two"], unique: "Unique +safe" },
  { format: "markdown", mapping: "tags", name: "TODO.md", rows: ["- [ ] Task", "- [ ]  TASK"], unique: "- [ ] Unique" },
] as const;

for (const shape of formats) {
  test(`incoming collision refuses before sync or upsert writes (${shape.format}/${shape.mapping})`, async () => {
    const ws = workspace();
    try {
      const input = join(ws.root, shape.name);
      // A safe row first proves refusal precedes even unrelated mutations.
      writeFileSync(input, `${shape.unique}\n${shape.rows.join("\n")}\n`);
      // Prime host-owned derived read caches before comparing all tracker bytes.
      assert.equal(ws.pm([...COMPLETE_LIST_COMMAND_ARGUMENTS]).status, 0);
      const before = snapshot(ws.tracker);
      const bytes = readFileSync(input);
      const options = ["--format", shape.format, "--todotxt-mapping", shape.mapping];
      for (const command of ["sync", "import"]) {
        for (const dryRun of [false, true]) {
          const result = ws.pm(["todos", command, input, ...options, ...(command === "import" ? ["--upsert"] : []), ...(dryRun ? ["--dry-run"] : [])]);
          assert.equal(result.status, 2, result.stderr);
          assert.match(result.stderr, /Ambiguous TODO rows/);
          assert.ok(result.stderr.includes(`${shape.name}:2`));
          assert.ok(result.stderr.includes(`${shape.name}:3`));
          assert.match(result.stderr, /distinct titles or embedded pm-id comments/);
          assert.deepEqual(readFileSync(input), bytes);
          assert.deepEqual(snapshot(ws.tracker), before);
        }
      }
      // Cover the same command/importer implementation through the public
      // harness with real CLI persistence, never substituted SDK operations.
      const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
      await assert.rejects(harness.runImporter({ importer: "todos", args: [input], options: { format: shape.format, todotxtMapping: shape.mapping, upsert: true }, pmRoot: ws.tracker }), /Ambiguous TODO rows/);
      assert.deepEqual(snapshot(ws.tracker), before);
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });

  test(`existing ambiguity refuses without writes (${shape.format}/${shape.mapping})`, async () => {
    const ws = workspace();
    try {
      const ids: string[] = [];
      for (const title of ["Task", "TASK"]) {
        const created = ws.pm(["create", "--title", title]);
        assert.equal(created.status, 0, created.stderr);
        ids.push((JSON.parse(created.stdout) as { id: string }).id);
      }
      const input = join(ws.root, shape.name);
      writeFileSync(input, `${shape.unique}\n${shape.rows[0]}\n`);
      // Prime host-owned derived read caches before comparing all tracker bytes.
      assert.equal(ws.pm([...COMPLETE_LIST_COMMAND_ARGUMENTS]).status, 0);
      const before = snapshot(ws.tracker);
      const bytes = readFileSync(input);
      for (const command of ["sync", "import"]) {
        for (const dryRun of [false, true]) {
          const result = ws.pm(["todos", command, input, "--format", shape.format, "--todotxt-mapping", shape.mapping, ...(command === "import" ? ["--upsert"] : []), ...(dryRun ? ["--dry-run"] : [])]);
          assert.equal(result.status, 2, result.stderr);
          assert.match(result.stderr, /matches multiple existing items/);
          assert.ok(result.stderr.includes(`${shape.name}:2`));
          for (const id of ids) assert.ok(result.stderr.includes(id));
          assert.deepEqual(readFileSync(input), bytes);
          assert.deepEqual(snapshot(ws.tracker), before);
        }
      }
      const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
      await assert.rejects(harness.runImporter({ importer: "todos", args: [input], options: { format: shape.format, todotxtMapping: shape.mapping, upsert: true, dryRun: true }, pmRoot: ws.tracker }), /matches multiple existing items/);
      assert.deepEqual(snapshot(ws.tracker), before);
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });

  test(`distinct titles create and single matches update normally (${shape.format}/${shape.mapping})`, async () => {
    const ws = workspace();
    try {
      const input = join(ws.root, shape.name);
      writeFileSync(input, `${shape.unique}\n${shape.rows[0]}\n`);
      for (const command of ["import", "import", "sync"]) {
        const result = ws.pm(["todos", command, input, "--format", shape.format, "--todotxt-mapping", shape.mapping, ...(command === "import" ? ["--upsert"] : [])]);
        assert.equal(result.status, 0, result.stderr);
        const receipt = JSON.parse(result.stdout) as { imported: number; updated: number; skipped: number };
        assert.equal(receipt.skipped, 0);
        assert.equal(receipt.imported + receipt.updated, 2);
        if (command === "sync") assert.equal(receipt.updated, 2);
      }
      const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
      const result = await harness.runImporter({ importer: "todos", args: [input], options: { format: shape.format, todotxtMapping: shape.mapping, upsert: true }, pmRoot: ws.tracker });
      assert.equal((result.result as { updated: number }).updated, 2);
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });
}

test("upsert checks collisions across files before creating earlier rows", async () => {
  const ws = workspace();
  const originalCwd = process.cwd();
  try {
    const first = join(ws.root, "first.md");
    const second = join(ws.root, "second.md");
    writeFileSync(first, "- [ ] Unique\n- [ ] Task\n");
    writeFileSync(second, "- [ ] task\n");
    assert.equal(ws.pm([...COMPLETE_LIST_COMMAND_ARGUMENTS]).status, 0);
    const before = snapshot(ws.tracker);
    const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
    process.chdir(ws.root);
    await assert.rejects(harness.runImporter({ importer: "todos", options: { glob: "*.md", upsert: true }, pmRoot: ws.tracker }), /first.md:2 and .*second.md:1/);
    assert.deepEqual(snapshot(ws.tracker), before);
    assert.equal(readFileSync(first, "utf8"), "- [ ] Unique\n- [ ] Task\n");
    assert.equal(readFileSync(second, "utf8"), "- [ ] task\n");
  } finally {
    process.chdir(originalCwd);
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("embedded pm ids update equal titles exactly and never fall back from a missing id", async () => {
  const ws = workspace();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const created = ws.pm(["create", "--title", "Task"]);
      assert.equal(created.status, 0, created.stderr);
      ids.push((JSON.parse(created.stdout) as { id: string }).id);
    }
    const input = join(ws.root, "TODO.md");
    writeFileSync(input, `- [ ] Task <!-- ${ids[0]} -->\n- [ ] Task <!-- ${ids[1]} -->\n`);
    const sync = ws.pm(["todos", "sync", input]);
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal((JSON.parse(sync.stdout) as { updated: number }).updated, 2);
    const harness = await createExtensionTestHarness(extension, { name: "pm-todos", capabilities: ["commands", "schema", "importers", "preflight"] });
    writeFileSync(input, "- [ ] Task <!-- pm-missing -->\n");
    const result = await harness.runImporter({ importer: "todos", args: [input], options: { upsert: true }, pmRoot: ws.tracker });
    assert.equal((result.result as { imported: number; updated: number }).imported, 1);
    assert.equal((result.result as { updated: number }).updated, 0);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("rows resolving to one existing item refuse before sync or upsert writes", async () => {
  const ws = workspace();
  try {
    const created = ws.pm(["create", "--title", "Shared target"]);
    assert.equal(created.status, 0, created.stderr);
    const id = (JSON.parse(created.stdout) as { id: string }).id;
    const input = join(ws.root, "TODO.md");
    // Two rows with one embedded id, and an id row plus an idless title match.
    for (const rows of [
      [`- [ ] Shared target <!-- ${id} -->`, `- [x] Shared target renamed <!-- ${id} -->`],
      [`- [ ] Renamed elsewhere <!-- ${id} -->`, "- [ ] Shared target"],
    ]) {
      writeFileSync(input, `- [ ] Unique\n${rows.join("\n")}\n`);
      assert.equal(ws.pm([...COMPLETE_LIST_COMMAND_ARGUMENTS]).status, 0);
      const before = snapshot(ws.tracker);
      const bytes = readFileSync(input);
      for (const command of ["sync", "import"]) {
        const result = ws.pm(["todos", command, input, "--format", "markdown", ...(command === "import" ? ["--upsert"] : [])]);
        assert.equal(result.status, 2, result.stderr);
        assert.match(result.stderr, new RegExp(`TODO\\.md:2 and \\S*TODO\\.md:3 resolve to the same item ${id}`));
        assert.deepEqual(readFileSync(input), bytes);
        assert.deepEqual(snapshot(ws.tracker), before);
      }
    }
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});
