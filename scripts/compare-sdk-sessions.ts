/** Compare built session APIs on immutable public tracker copies outside git. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listAllComplete } from "@unbrained/pm-cli/sdk";

/** Snapshot all copied files, including any unexpected SDK-created state. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  /** Traverse in stable order without following symlinks. */
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else { assert.ok(entry.isFile()); hash.update(file.slice(root.length)); hash.update(readFileSync(file)); }
    }
  }
  visit(root);
  return hash.digest("hex");
}

/** Set immutable input permissions, or restore directory ownership for cleanup. */
function permissions(root: string, readonly: boolean): void {
  chmodSync(root, 0o755);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) permissions(file, readonly);
    else chmodSync(file, readonly ? 0o444 : 0o644);
  }
  if (readonly) chmodSync(root, 0o555);
}

/** Extract committed data only; never copy mutable checkout caches or local data. */
function archive(repo: string, ref: string, destination: string, paths: string[] = []): void {
  mkdirSync(destination, { recursive: true });
  const tar = execFileSync("git", ["-C", repo, "archive", "--format=tar", ref, ...paths], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", destination], { input: tar });
}

const repos = process.argv.slice(2).map(repo => resolve(repo));
assert.ok(repos.length, "Pass public fleet repository directories as arguments.");
const repoRoot = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "todos-session-differential-"));
const immutable: string[] = [];
try {
  const before = join(scratch, "before");
  archive(repoRoot, "origin/main", before);
  symlinkSync(join(repoRoot, "node_modules"), join(before, "node_modules"), "dir");
  execFileSync(join(repoRoot, "node_modules", ".bin", "tsc"), ["-p", before], { stdio: "pipe" });
  const nodeOnly = join(scratch, "bin");
  mkdirSync(nodeOnly);
  symlinkSync(process.execPath, join(nodeOnly, basename(process.execPath)));
  for (const [index, repo] of repos.entries()) {
    const remote = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    assert.match(remote, /^https:\/\/github\.com\/unbraind\/pm-[a-z-]+(?:\.git)?$/);
    const head = execFileSync("git", ["-C", repo, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
    const copy = join(scratch, `fleet-${index}`);
    archive(repo, "origin/main", copy, [".agents/pm"]);
    immutable.push(copy);
    permissions(copy, true);
    const initial = fingerprint(copy);
    const pmRoot = join(copy, ".agents", "pm");
    const items = (await listAllComplete({}, { pmRoot, cwd: copy })).items;
    const input = join(scratch, `items-${index}.json`);
    writeFileSync(input, JSON.stringify(items));
    const outputs: string[] = [];
    for (const [label, module] of [["before", join(before, "dist", "index.js")], ["after", join(repoRoot, "dist", "index.js")]]) {
      const runner = join(scratch, `runner-${index}-${label}.mjs`);
      writeFileSync(runner, `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTodoEditingSession as create, reconcileTodoEditingSession as reconcile, planTodoEditingSession as plan, exportTodoEditingSession as exportSession, applyTodoEditingSession as apply } from ${JSON.stringify(pathToFileURL(module).href)};
const items = JSON.parse(readFileSync(${JSON.stringify(input)}, 'utf8'));
const eligible = [], rejected = [];
for (const item of items) { try { create([item]); eligible.push(item); } catch (error) { rejected.push([item.id, error.name, error.message]); } }
assert.ok(eligible.length);
const {session, text} = create(eligible);
const edited = text.split('\\n').map(row => row ? '(A) SDK audit edit pm-session:' + row.slice(row.lastIndexOf('pm-session:') + 11) : '').join('\\n');
const conflict = eligible.map((item, index) => index ? item : {...item, title:'Concurrent'});
const cases = [reconcile(session,text,eligible), reconcile(session,edited,eligible), reconcile(session,edited,conflict), reconcile(session,'',eligible), reconcile(session,text + text,eligible), reconcile(session,text.split('\\n').reverse().join('\\n'),eligible), reconcile(session,'Unidentified task',eligible), reconcile({...session,digest:'bad'},text,eligible), plan(session,edited,eligible)];
let exported;
try { exported = await exportSession(${JSON.stringify(pmRoot)}); } catch (error) { exported = {name:error.name,message:error.message}; }
cases.push(exported, await apply(${JSON.stringify(pmRoot)},session,edited,{author:'test-agent',dryRun:true}));
process.stdout.write(JSON.stringify({total:items.length,eligible:eligible.length,rejected,session,text,cases}));
`);
      outputs.push(execFileSync(process.execPath, [runner], {
        cwd: copy, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PATH: nodeOnly, GIT_CEILING_DIRECTORIES: dirname(copy), PM_TELEMETRY_DISABLED: "1" },
      }));
    }
    assert.equal(outputs[1], outputs[0], "Session outputs must match origin/main byte for byte");
    assert.equal(fingerprint(copy), initial, "Differential functions must leave copied tracker bytes unchanged");
    const result = JSON.parse(outputs[0]) as { total: number; eligible: number; rejected: unknown[]; cases: unknown[] };
    console.log(JSON.stringify({ repo: basename(repo), head, total: result.total, eligible: result.eligible, rejected: result.rejected.length, cases: result.cases.length, identical: true, trackerUnchanged: true, gitOnPath: false }));
  }
} finally {
  for (const copy of immutable) permissions(copy, false);
  rmSync(scratch, { recursive: true, force: true });
}
