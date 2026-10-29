/** Validation corpus boundaries must never read or chmod outside their disposable trees. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { devNull, tmpdir } from "node:os";
import test from "node:test";
import { init, PmClient } from "@unbrained/pm-cli/sdk";
import { fingerprintValidationTree, readonlyValidationTree, VALIDATION_CACHE_NAMES } from "../scripts/validation-tree.ts";

/** Snapshot only test-owned targets, retaining bytes and exact permission bits. */
function state(path: string) {
  const stat = statSync(path);
  return { mode: stat.mode & 0o7777, bytes: stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : undefined };
}

test("seed 0x73616665: 500 validation-tree link variants refuse before permission writes", () => {
  const root = mkdtempSync(join(tmpdir(), "todos-validation-links-")), outside = join(root, "outside");
  mkdirSync(outside); writeFileSync(join(outside, "executable"), "Disposable executable sentinel");
  chmodSync(outside, 0o751); chmodSync(join(outside, "executable"), 0o750);
  const before = [state(outside), state(join(outside, "executable"))];
  let seed = 0x73616665;
  try {
    for (let index = 0; index < 500; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const tree = join(root, "tree"); mkdirSync(tree); writeFileSync(join(tree, "ordinary"), "Regular corpus control");
      const nested = join(tree, "nested"); mkdirSync(nested);
      const link = join(seed & 1 ? nested : tree, "probe"), kind = (seed >>> 1) % 6;
      if (kind === 0) symlinkSync(join(outside, "executable"), link);
      else if (kind === 1) symlinkSync(seed & 1 ? "../../outside/executable" : "../outside/executable", link);
      else if (kind === 2) symlinkSync(outside, link, "dir");
      else if (kind === 3) symlinkSync("missing-target", link);
      else if (kind === 4) symlinkSync("probe", link);
      else linkSync(join(outside, "executable"), link);
      try {
        const ordinary = state(join(tree, "ordinary"));
        assert.throws(() => readonlyValidationTree(tree), /unsafe_validation_entry/);
        assert.throws(() => fingerprintValidationTree(tree), /unsafe_validation_entry/);
        assert.deepEqual(state(join(tree, "ordinary")), ordinary, "Whole-tree validation precedes every chmod");
        assert.deepEqual([state(outside), state(join(outside, "executable"))], before);
      } finally { rmSync(tree, { recursive: true, force: true }); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("permission restoration uses owned descriptors after links replace files, directories and the copy root", () => {
  const root = mkdtempSync(join(tmpdir(), "todos-validation-restore-")), tree = join(root, "tree"), outside = join(root, "outside");
  mkdirSync(tree); mkdirSync(outside);
  const owned = join(tree, "executable"), external = join(outside, "executable");
  writeFileSync(owned, "Owned corpus"); writeFileSync(external, "Foreign sentinel");
  chmodSync(tree, 0o750); chmodSync(owned, 0o751); chmodSync(outside, 0o710); chmodSync(external, 0o640);
  const initial = state(owned), foreign = [state(outside), state(external)], fingerprint = fingerprintValidationTree(tree);
  let restore: (() => void) | undefined;
  try {
    restore = readonlyValidationTree(tree);
    assert.equal(statSync(tree).mode & 0o777, 0o555); assert.equal(statSync(owned).mode & 0o777, 0o444);
    // The parent is test-owned and writable; replace the complete frozen tree.
    const detached = join(root, "detached"); renameSync(tree, detached); symlinkSync(outside, tree, "dir");
    restore(); restore();
    assert.deepEqual([state(outside), state(external)], foreign);
    assert.equal(statSync(detached).mode & 0o777, 0o750);
    assert.deepEqual(state(join(detached, "executable")), initial);
    assert.deepEqual(fingerprintValidationTree(detached), fingerprint);
    assert.throws(() => fingerprintValidationTree(tree), /unsafe_validation_entry/);
    // A link introduced after freezing must also be irrelevant to restoration.
    rmSync(tree); renameSync(detached, tree);
    restore = readonlyValidationTree(tree);
    chmodSync(tree, 0o750); renameSync(owned, join(tree, "saved")); symlinkSync(external, owned);
    restore();
    assert.deepEqual([state(outside), state(external)], foreign);
    assert.deepEqual(state(join(tree, "saved")), initial);
  } finally {
    try { restore?.(); }
    finally {
      // Also restore this test's own sentinels when running a deliberately reverted guard.
      chmodSync(outside, 0o710); chmodSync(external, 0o640);
      for (const path of [tree, join(root, "detached")]) if (existsSync(path) && lstatSync(path).isDirectory()) chmodSync(path, 0o750);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("validation rejects special files without blocking and preserves explicitly excluded cache behavior", () => {
  const root = mkdtempSync(join(tmpdir(), "todos-validation-special-")), tree = join(root, "tree");
  mkdirSync(tree); writeFileSync(join(tree, "regular"), "Ordinary old corpus input");
  try {
    const ordinary = fingerprintValidationTree(tree, VALIDATION_CACHE_NAMES);
    // The copy producer excludes these names too; the linked cache is never accessed.
    symlinkSync("missing-cache-target", join(tree, "extensions"));
    assert.deepEqual(fingerprintValidationTree(tree, VALIDATION_CACHE_NAMES), ordinary);
    assert.throws(() => fingerprintValidationTree(tree), /unsafe_validation_entry/);
    assert.throws(() => readonlyValidationTree(join(tree, "regular")), /unsafe_validation_entry/);
    rmSync(join(tree, "extensions"));
    if (process.platform !== "win32") {
      const result = spawnSync("mkfifo", [join(tree, "pipe")], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.throws(() => readonlyValidationTree(tree), /unsafe_validation_entry/);
      assert.throws(() => fingerprintValidationTree(tree), /unsafe_validation_entry/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Seed real native rows and a public-shaped git corpus; use a disposable runtime for hostile links. */
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "todos-validation-corpus-")), repo = join(root, "repo"), pmRoot = join(repo, ".agents", "pm"), runtime = join(root, "node");
  mkdirSync(repo); copyFileSync(process.execPath, runtime); chmodSync(runtime, 0o751);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment: NodeJS.ProcessEnv = { ...process.env, NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull, PM_GLOBAL_PATH: join(root, "global"), PM_AUTHOR: "validation-agent", GIT_CEILING_DIRECTORIES: dirname(root) };
  delete environment.PM_PATH;
  for (const key of Object.keys(environment)) if (/token|secret|password|credential|api.?key|private.?key|access.?key|^NPM_MEDIA_SERVER$/i.test(key)) delete environment[key];
  await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
  const client = new PmClient({ pmRoot, author: "validation-agent" });
  for (let index = 0; index < 3; index++) await client.create({ title: "Corpus task " + index, type: "Task", parent: "none", blockedBy: "none", dep: [], sprint: "none", release: "none" });
  /** Execute only fixture git operations; never discover or modify an enclosing checkout. */
  function git(args: string[]) {
    const result = spawnSync("git", ["-C", repo, ...args], { env: environment, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  }
  git(["init", "--initial-branch=main"]); git(["remote", "add", "origin", "https://github.com/unbraind/pm-validation-fixture.git"]);
  /** Publish exactly the fixture tracker as the immutable source revision. */
  function commit() {
    git(["add", ".agents/pm"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Synthetic validation corpus"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  }
  /** Run each actual validator with a runtime whose mode the test may safely restore on failure. */
  function run(script: string, ordinary = false) {
    const supplied = ["validate-sessions.ts", "validate-source-watcher.ts"].includes(script);
    const copy = join(root, "supplied"); rmSync(copy, { recursive: true, force: true });
    if (supplied) cpSync(pmRoot, copy, { recursive: true, verbatimSymlinks: true });
    const restore = ordinary && script === "validate-source-watcher.ts" ? readonlyValidationTree(copy) : undefined;
    try { return spawnSync(runtime, [resolve("scripts", script), supplied ? copy : repo], { cwd: root, env: environment, encoding: "utf8", timeout: 120000 }); }
    finally { restore?.(); }
  }
  return { root, pmRoot, runtime, commit, run };
}

const VALIDATORS = readdirSync(resolve("scripts")).filter(name => name.startsWith("validate-") || name === "compare-sdk-sessions.ts").sort();

test("every public-corpus validator rejects archived and supplied links without changing an outside executable", { timeout: 360000 }, async t => {
  const f = await fixture(t), original = statSync(f.runtime).mode & 0o7777;
  // proc/self resolves to the cloned executable, never the host's Node executable.
  const targets = [...(process.platform === "linux" ? ["/proc/self/exe"] : []), f.runtime];
  for (const target of targets) {
    const probe = join(f.pmRoot, "probe"); rmSync(probe, { force: true }); symlinkSync(target, probe); f.commit();
    for (const script of VALIDATORS) {
      try {
        const result = f.run(script);
        assert.equal(statSync(f.runtime).mode & 0o7777, original, script + " changed an outside executable");
        assert.notEqual(result.status, 0, script + " accepted a linked validation input");
        assert.match(result.stderr, /unsafe_validation_entry/, script + ": " + result.stderr);
      } finally { chmodSync(f.runtime, original); }
    }
  }
});

test("all public-corpus validators retain ordinary native tracker behavior", { timeout: 240000 }, async t => {
  const f = await fixture(t); f.commit();
  const before = fingerprintValidationTree(f.pmRoot), executable = state(f.runtime);
  for (const script of VALIDATORS) {
    const result = f.run(script, true);
    assert.equal(result.status, 0, script + ": " + result.stderr);
    const receipt = JSON.parse(result.stdout.trim());
    assert.equal(receipt.items ?? receipt.total, 3);
    assert.deepEqual(fingerprintValidationTree(f.pmRoot), before);
    assert.deepEqual(state(f.runtime), executable);
  }
});
