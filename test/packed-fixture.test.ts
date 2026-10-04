import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { packInvocation } from "./packed-fixture.ts";

test("Windows packing uses Node's npm entrypoint with literal destination arguments", () => {
  const destination = "C:\\User Data\\archive & %fixture%";
  const entrypoint = "C:\\Program Files\\nodejs\\npm-cli.js";
  const invocation = packInvocation(destination, "win32", { npm_execpath: entrypoint });
  assert.equal(invocation.executable, process.execPath);
  assert.equal(invocation.shell, false);
  assert.deepEqual(invocation.arguments, [entrypoint, "pack", "--ignore-scripts", "--pack-destination", destination]);
});

test("Windows packing falls back to npm beside the Node installation", () => {
  const invocation = packInvocation("archive", "win32", {});
  assert.equal(invocation.arguments[0], join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"));
  assert.equal(invocation.executable, process.execPath);
  assert.equal(invocation.shell, false);
});

test("POSIX packing leaves destination arguments unquoted and uses no shell", () => {
  const destination = "/tmp/archive with spaces & %fixture%";
  const invocation = packInvocation(destination, "linux", {});
  assert.equal(invocation.executable, "npm");
  assert.equal(invocation.shell, false);
  assert.deepEqual(invocation.arguments, ["pack", "--ignore-scripts", "--pack-destination", destination]);
});

test("the Windows invocation preserves spaced entrypoint and shell metacharacters in a real subprocess", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-todos pack & fixture-"));
  try {
    const entrypoint = join(root, "npm entrypoint.mjs");
    writeFileSync(entrypoint, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const destination = join(root, "archive & %fixture%");
    const invocation = packInvocation(destination, "win32", { npm_execpath: entrypoint });
    const result = execFileSync(invocation.executable, invocation.arguments, {
      encoding: "utf8", shell: invocation.shell,
    });
    assert.deepEqual(JSON.parse(result), ["pack", "--ignore-scripts", "--pack-destination", destination]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
