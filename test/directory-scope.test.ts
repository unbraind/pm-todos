/** Confined filesystem operations must survive ancestor ABA swaps at every syscall boundary. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { DirectoryScopeError, directoryDescriptorPath, openDirectoryScope } from "../directory-scope.ts";
import { copyValidationTree, fingerprintValidationTree, readonlyValidationTree } from "../scripts/validation-tree.ts";

const METHODS = ["lstatSync", "openSync", "fstatSync", "readdirSync", "readFileSync", "fchmodSync"] as const;
/** Populate matching ordinary and foreign trees with distinguishable, test-owned sentinel bytes. */
function fixture(depth: number) {
  const root = fs.mkdtempSync(join(tmpdir(), "todos-directory-aba-")), tree = join(root, "tree"), outside = join(root, "outside");
  const names = Array.from({ length: depth }, (_, index) => "level-" + index);
  fs.mkdirSync(join(tree, ...names), { recursive: true }); fs.mkdirSync(join(outside, ...names), { recursive: true });
  for (const [directory, value] of [[tree, "Owned source"], [outside, "Foreign sentinel"]]) {
    fs.writeFileSync(join(directory, ...names, "sentinel"), value);
    fs.chmodSync(join(directory, ...names, "sentinel"), 0o751);
  }
  const foreign = fingerprintValidationTree(outside), mode = fs.statSync(join(outside, ...names, "sentinel")).mode;
  return { root, tree, outside, names, foreign, mode };
}

/** Inject one directory/link/directory ABA interval without changing the host runtime or real data. */
function attack(t: test.TestContext, f: ReturnType<typeof fixture>, step: number, after: boolean, operation: () => void, level = 0) {
  const original = Object.fromEntries(METHODS.map(name => [name, fs[name]])) as Pick<typeof fs, typeof METHODS[number]>;
  const held = join(f.root, "held");
  const target = join(f.tree, ...f.names.slice(0, level)), replacement = join(f.outside, ...f.names.slice(0, level));
  let active = false, swapped = false, count = 0, firstPermission: number | undefined, foreignRead = false, foreignWrite = false;
  const foreignPaths = [f.outside, ...fs.readdirSync(f.outside, { recursive: true }).map(name => join(f.outside, String(name)))];
  const foreignModes = foreignPaths.map(path => fs.statSync(path).mode);
  const foreignInodes = new Set(foreignPaths.map(path => { const stat = fs.statSync(path); return stat.dev + ":" + stat.ino; }));
  /** Restore the original directory name, including on a deliberately reverted implementation. */
  function undo() {
    if (!swapped) return;
    fs.unlinkSync(target); fs.renameSync(held, target); swapped = false;
  }
  /** Replace only this test-owned ancestor; its containing scratch directory stays writable. */
  function swap() {
    if (swapped) return;
    fs.renameSync(target, held); fs.symlinkSync(replacement, target, "dir"); swapped = true;
  }
  /** Preserve each native function's overloads while observing its exact call boundary. */
  function instrument<K extends typeof METHODS[number]>(name: K) {
    const native = original[name];
    t.mock.method(fs, name, ((...args: unknown[]) => {
      if (!active) return Reflect.apply(native, fs, args);
      const current = ++count;
      if (name === "fchmodSync" && firstPermission === undefined) firstPermission = current;
      if (current === step && !after) swap();
      if ((name === "readFileSync" || name === "fchmodSync") && typeof args[0] === "number") {
        const observed = original.fstatSync(args[0]);
        if (foreignInodes.has(observed.dev + ":" + observed.ino)) {
          if (name === "readFileSync") foreignRead = true; else foreignWrite = true;
        }
      }
      const result = Reflect.apply(native, fs, args);
      if (name === "openSync" && typeof args[0] === "string" && ["sentinel", "output"].includes(basename(args[0]))) undo();
      if (current === step && after) swap();
      return result;
    }) as typeof native);
  }
  try {
    for (const name of METHODS) instrument(name);
    syncBuiltinESMExports(); active = true;
    operation();
    active = false;
    assert.equal(foreignRead, false, "A swapped ancestor exposed foreign bytes");
    assert.equal(foreignWrite, false, "A swapped ancestor authorized an outside chmod");
  } finally {
    active = false; t.mock.restoreAll(); syncBuiltinESMExports(); undo();
  }
  assert.deepEqual(fingerprintValidationTree(f.outside), f.foreign);
  assert.deepEqual(foreignPaths.map(path => fs.statSync(path).mode), foreignModes);
  assert.equal(fs.statSync(join(f.outside, ...f.names, "sentinel")).mode, f.mode);
  return { count, firstPermission };
}

/** Exercise the same collector's read and permission paths, permitting only a safe race refusal. */
function validate(f: ReturnType<typeof fixture>, mode: "reads" | "chmod" | "copy", expected: ReturnType<typeof fingerprintValidationTree>) {
  let restore: (() => void) | undefined;
  const copy = join(f.root, "copy");
  try {
    if (mode === "chmod") restore = readonlyValidationTree(f.tree);
    else if (mode === "copy") {
      copyValidationTree(f.tree, copy); assert.deepEqual(fingerprintValidationTree(copy), expected);
      assert.equal(fs.statSync(join(copy, ...f.names, "sentinel")).mode & 0o100, 0o100, "Private copies retain owner execution permission");
    }
    else assert.deepEqual(fingerprintValidationTree(f.tree), expected);
  } catch (error) {
    assert.ok(error instanceof Error && error.message.startsWith("unsafe_validation_entry"), String(error));
  } finally { restore?.(); fs.rmSync(copy, { recursive: true, force: true }); }
}

for (const mode of ["reads", "chmod", "copy"] as const) test("every validation traversal boundary resists ancestor ABA for " + mode, t => {
  let attempted = 0;
  for (const depth of [0, 3]) {
    const f = fixture(depth), expected = fingerprintValidationTree(f.tree);
    try {
      const baseline = attack(t, f, -1, false, () => validate(f, mode, expected));
      for (let level = 0; level <= depth; level++) {
        // Once the guard freezes a parent, ordinary writers cannot rename its child.
        // Retained-handle restoration after freezing has its own original regression.
        const limit = level && baseline.firstPermission !== undefined ? baseline.firstPermission - 1 : baseline.count;
        for (let step = 1; step <= limit; step++) for (const after of [false, true]) {
          attack(t, f, step, after, () => validate(f, mode, expected), level);
          attempted++;
        }
      }
    } finally { fs.chmodSync(join(f.outside, ...f.names, "sentinel"), 0o751); fs.rmSync(f.root, { recursive: true, force: true }); }
  }
  t.diagnostic("Checked " + attempted + " before/after traversal boundaries for " + mode + ".");
});

test("seed 0x64697266: 500 scoped read/create/replay operations resist ancestor ABA", t => {
  let seed = 0x64697266;
  for (let index = 0; index < 500; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const f = fixture(seed % 4), file = [...f.names, "sentinel"].join("/"), output = [...f.names, "output"].join("/");
    const step = (seed >>> 4) % 45 + 1;
    let scope: ReturnType<typeof openDirectoryScope> | undefined;
    try {
      attack(t, f, step, Boolean(seed & 1), () => {
        try {
          scope = openDirectoryScope(f.tree);
          const prepared = scope.file(seed & 2 ? output : file);
          const fd = prepared.open(Boolean(seed & 2));
          try {
            if (seed & 2) fs.writeFileSync(fd, "Owned output");
            else assert.equal(fs.readFileSync(fd, "utf8"), "Owned source");
          } finally { fs.closeSync(fd); }
          scope.close(); scope.close();
          assert.throws(() => prepared.open(), DirectoryScopeError);
          assert.throws(() => scope!.open(file), DirectoryScopeError);
        } catch (error) { assert.ok(error instanceof DirectoryScopeError, String(error)); }
        finally { scope?.close(); }
      });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("directory scopes reject unsafe components, linked files and missing descriptor views", t => {
  const f = fixture(1), scope = openDirectoryScope(f.tree);
  try {
    for (const name of ["", ".", "..", "../sentinel", "/sentinel", "level-0/../sentinel", "level-0//sentinel", "bad\\name", "bad\u0000name"]) assert.throws(() => scope.open(name), DirectoryScopeError);
    fs.symlinkSync(f.outside, join(f.tree, "linked"), "dir");
    assert.throws(() => scope.open("linked/level-0/sentinel"), DirectoryScopeError);
    fs.symlinkSync(join(f.outside, "level-0", "sentinel"), join(f.tree, "leaf"));
    assert.throws(() => scope.open("leaf"), DirectoryScopeError);
    fs.linkSync(join(f.outside, "level-0", "sentinel"), join(f.tree, "hard"));
    assert.throws(() => scope.open("hard"), DirectoryScopeError);
    assert.throws(() => scope.open("level-0"), DirectoryScopeError);
    assert.throws(() => scope.open("missing/sentinel"), DirectoryScopeError);
    const regular = fs.openSync(join(f.tree, "level-0", "sentinel"), "r");
    try { assert.throws(() => directoryDescriptorPath(regular), DirectoryScopeError); } finally { fs.closeSync(regular); }
    assert.throws(() => directoryDescriptorPath(-1), DirectoryScopeError);
    const native = fs.openSync;
    t.mock.method(fs, "openSync", ((...args: Parameters<typeof native>) => {
      if (String(args[0]).startsWith("/proc/self/fd/") || String(args[0]).startsWith("/dev/fd/")) throw new Error("Descriptor view unavailable");
      return native(...args);
    }) as typeof native);
    syncBuiltinESMExports();
    assert.throws(() => openDirectoryScope(f.tree), DirectoryScopeError);
    assert.throws(() => readonlyValidationTree(f.tree), /unsafe_validation_entry/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); scope.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
