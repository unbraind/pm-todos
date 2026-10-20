import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("legacy CLI fixture skips before POSIX setup on Windows", () => {
  const fixture = fileURLToPath(new URL("./legacy-import-cli.test.ts", import.meta.url));
  // Simulate Windows without needing symlink privileges or a POSIX launcher.
  // Throw before allocating a temp tracker if the fixture accidentally runs.
  const bootstrap = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    Object.defineProperty(process, "platform", { value: "win32" });
    fs.mkdtempSync = () => { throw new Error("POSIX fixture setup ran on Windows"); };
    syncBuiltinESMExports();
  `;
  const preload = `data:text/javascript,${encodeURIComponent(bootstrap)}`;
  const result = spawnSync(process.execPath, ["--test-reporter=tap", "--import", preload, fixture], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# SKIP POSIX symlink\/shebang fixture/u);
  assert.match(result.stdout, /# skipped 1/u);
});
