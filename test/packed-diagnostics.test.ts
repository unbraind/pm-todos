import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { create, get, init } from "@unbrained/pm-cli/sdk";
import { PackedCommandError, packedMatrixReport, runPackedCommand, summarizePackedOutput, type PackedAcceptanceState } from "../scripts/packed-diagnostics.ts";

/** Make a real non-git tracker and a partial matrix without SDK substitution. */
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "todos-packed-diagnostics-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, "tracker");
  await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
  const { item } = await create({ title: "Private fixture body", type: "Task", author: "test-agent" }, { pmRoot });
  const state: PackedAcceptanceState = {
    scenario: "bun-current", phase: "initialize", selected_scenarios: ["npm-current", "bun-current", "npm-minimum", "bun-minimum", "npm-global", "bun-global"],
    runtimes: { node: process.version, npm: "11.0.0", bun: "1.4.4" },
    receipts: [{ scenario: "npm-current" }],
  };
  return { root, pmRoot, item, state };
}

test("real subprocess timeout retains safe progress, runtime and partial coverage without fixture data", async t => {
  const { root, pmRoot, item, state } = await fixture(t);
  const body = String((await get(String(item.id), {}, { pmRoot })).item.title);
  let failure: unknown;
  try {
    runPackedCommand(state, process.execPath, ["-e", "process.stdout.write('Resolving dependencies\\n'); process.stderr.write(process.argv[1]); setInterval(() => {}, 1000);", root + " token=synthetic-secret " + body + "\n"], root, { GIT_CEILING_DIRECTORIES: dirname(root) }, 0, 3000);
  } catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /bun-current/);
  assert.match(failure.message, /initialize/);
  assert.match(failure.message, /ETIMEDOUT/);
  assert.match(failure.message, /Resolving dependencies/);
  assert.match(failure.message, /npm-current/);
  assert.match(failure.message, /"matrix_complete":false/);
  assert.match(failure.message, /1\.4\.4/);
  for (const privateValue of [root, "synthetic-secret", body, "setInterval"]) assert.ok(!failure.message.includes(privateValue));
  assert.ok(failure instanceof PackedCommandError);
  assert.equal(failure.report.signal, "SIGKILL");
  assert.equal(failure.report.timeout_ms, 3000);
  assert.deepEqual(failure.report.receipts, [{ scenario: "npm-current" }]);
});

test("nonzero exit, missing executable and expected refusal share the same fail-closed boundary", async t => {
  const { root, state } = await fixture(t);
  assert.throws(() => runPackedCommand(state, process.execPath, ["-e", "process.stderr.write('Saved lockfile\\nprivate-content'); process.exit(23)"], root, {}), error => {
    assert.ok(error instanceof PackedCommandError);
    assert.equal(error.report.status, 23);
    assert.deepEqual(error.report.stderr.progress, ["Saved lockfile"]);
    assert.ok(!error.message.includes("private-content"));
    return true;
  });
  assert.throws(() => runPackedCommand(state, join(root, "missing-executable"), [], root, {}), PackedCommandError);
  assert.equal(runPackedCommand(state, process.execPath, ["-e", "process.exit(1)"], root, {}, 1).status, 1);
  assert.equal(runPackedCommand(state, process.execPath, ["-e", "process.stdout.write('success')"], root, {}).stdout, "success");
});

test("stream previews are bounded, allowlisted and omit credentials, paths and fixture content", () => {
  const privateText = "synthetic-secret Private fixture body " + join(tmpdir(), "private-fixture");
  const summary = summarizePackedOutput("Resolving dependencies\n" + privateText.repeat(20000) + "\nSaved lockfile\n");
  assert.equal(summary.truncated, true);
  assert.deepEqual(summary.progress, ["Resolving dependencies", "Saved lockfile"]);
  assert.ok(JSON.stringify(summary).length < 2048);
  assert.ok(!JSON.stringify(summary).includes("synthetic-secret"));
  assert.deepEqual(summarizePackedOutput(null).progress, []);
  assert.deepEqual(summarizePackedOutput("\u001b[32mInstalling dependencies\u001b[0m\n").progress, ["Installing dependencies"]);
  assert.equal(summarizePackedOutput("Saved lockfile\n".repeat(1000)).progress.length, 16);
  assert.equal(summarizePackedOutput("Resolved, downloaded and extracted [123]\nbun init v1.4.4 (38afee6c8)\n").progress.length, 2);
});

test("only a complete ordered selected matrix can produce a success receipt", async t => {
  const { state } = await fixture(t);
  assert.throws(() => packedMatrixReport(state, true), /incomplete/);
  assert.equal(packedMatrixReport(state, false).matrix_complete, false);
  state.receipts = state.selected_scenarios.map(scenario => ({ scenario }));
  assert.equal(packedMatrixReport(state, true).ok, true);
  state.receipts.reverse();
  assert.throws(() => packedMatrixReport(state, true), /misordered/);
  state.selected_scenarios = [];
  state.receipts = [];
  assert.throws(() => packedMatrixReport(state, true), /incomplete/);
});

test("the actual acceptance entrypoint emits incomplete JSON and exits nonzero on setup failure", async t => {
  const { root } = await fixture(t);
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  for (const name of ["accept-packed.ts", "packed-diagnostics.ts"]) cpSync(join(import.meta.dirname, "..", "scripts", name), join(scripts, name));
  cpSync(join(import.meta.dirname, "..", "package.json"), join(root, "package.json"));
  symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(root, "node_modules"), "dir");
  // Fault injection changes only executable selection in this disposable copy.
  // Real package managers and tracker SDKs remain untouched.
  const launcher = join(root, "fail-pack.cjs");
  writeFileSync(launcher, "if (process.argv.includes('--version')) console.log('11.0.0'); else { console.log('Resolving dependencies'); console.error('synthetic-secret Private fixture body'); process.exit(23); }\n");
  const loader = join(root, "inject.cjs");
  writeFileSync(loader, "const cp = require('node:child_process'); const { dirname, join } = require('node:path'); const launcher = join(dirname(dirname(process.argv[1])), 'fail-pack.cjs'); const original = cp.spawnSync; cp.spawnSync = (command, args, options) => original(process.execPath, [launcher, ...args], options); require('node:module').syncBuiltinESMExports();\n");
  for (const selection of [[], ["npm-current"]]) {
    const result = spawnSync(process.execPath, ["--require", loader, join(scripts, "accept-packed.ts"), ...selection], { cwd: root, encoding: "utf8", timeout: 15000,
      env: { NPM_CONFIG_USERCONFIG: devNull, GIT_CEILING_DIRECTORIES: dirname(root) } });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const report = JSON.parse(result.stderr.trim().split("\n").find(line => line.startsWith("{"))!);
    assert.equal(report.matrix_complete, false);
    assert.equal(report.phase, "pack");
    assert.equal(report.status, 23);
    assert.equal(report.timeout_ms, 300000);
    assert.equal(report.selected_scenarios.length, selection.length ? 1 : 6);
    assert.equal(report.runtimes.bun, selection.length ? undefined : "11.0.0");
    assert.deepEqual(report.receipts, []);
    assert.deepEqual(report.stdout.progress, ["Resolving dependencies"]);
    assert.ok(!result.stderr.includes(root));
    assert.ok(!result.stderr.includes("synthetic-secret"));
  }
});
