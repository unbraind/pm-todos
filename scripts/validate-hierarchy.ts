import { fingerprintValidationTree, readonlyValidationTree } from "./validation-tree.ts";
/** Measure hierarchy previews on committed public tracker data in a read-only non-git copy. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { applyTodoHierarchy, exportTodoHierarchy } from "../index.ts";


const source = process.argv[2];
if (!source) throw new Error("Pass a public fleet package repository.");
const repo = resolve(source), scratch = mkdtempSync(join(tmpdir(), "todos-hierarchy-public-")), copy = join(scratch, "copy");
const previousPath = process.env.PATH, previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
let restore: (() => void) | undefined;
try {
  const remote = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  assert.match(remote, /^https:\/\/github\.com\/unbraind\/pm-[a-z-]+(?:\.git)?$/);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
  const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", head, ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 });
  mkdirSync(copy); execFileSync("tar", ["-xf", "-", "-C", copy], { input: archive });
  const pmRoot = join(copy, ".agents", "pm"), initial = fingerprintValidationTree(copy).digest;
  restore = readonlyValidationTree(copy);
  const bin = join(scratch, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  process.env.PATH = bin; process.env.GIT_CEILING_DIRECTORIES = dirname(copy);
  const complete = await listAllComplete({}, { pmRoot, cwd: copy });
  const exported = await exportTodoHierarchy(pmRoot, complete.items.map(item => item.id));
  const unchanged = await applyTodoHierarchy(pmRoot, exported.session, exported.text, { author: "validation-agent", dryRun: true });
  assert.equal(unchanged.ok, true, JSON.stringify(unchanged)); assert.equal(unchanged.changed, 0);
  let proposal: Awaited<ReturnType<typeof applyTodoHierarchy>> | undefined;
  const lines = exported.text.trimEnd().split("\n");
  const roots = lines.map((line,index) => ({ line, index })).filter(({line,index}) => line.startsWith("- ") && (!lines[index+1] || lines[index+1].startsWith("- ")));
  const available = roots.filter(row => {
    const id = /pm-session:([^ ]+)/.exec(row.line)?.[1];
    return complete.items.some(item => item.id === id && !item.assignee);
  });
  const refused = new Map<string, number>();
  for (const child of available.slice(0, 2)) {
    const parent = available.find(candidate => candidate.index !== child.index);
    if (!parent) break;
    const childId = /pm-session:([^ ]+)/.exec(child.line)![1], parentId = /pm-session:([^ ]+)/.exec(parent.line)![1];
    const pair = await exportTodoHierarchy(pmRoot, [parentId, childId]);
    const edited = pair.text.trimEnd().split("\n"); edited[1] = "  " + edited[1];
    const candidate = await applyTodoHierarchy(pmRoot, pair.session, edited.join("\r\n") + "\r\n", { author: "validation-agent", dryRun: true });
    if (candidate.ok && candidate.changed === 1) { proposal = candidate; break; }
    for (const refusal of candidate.refusals) { const code = refusal.nativeCode ?? refusal.code; refused.set(code, (refused.get(code) ?? 0) + 1); }
  }
  assert.ok(proposal, "Read-only changed relation previews must succeed without a staging-permission bypass");
  assert.equal(fingerprintValidationTree(copy).digest, initial);
  // The archive is the complete immutable input; no source checkout files are opened for writes.
  console.log(JSON.stringify({ repo: basename(repo), head, items: complete.items.length, exported: exported.session.rows.length, skipped: exported.skipped, text_bytes: Buffer.byteLength(exported.text), session_bytes: Buffer.byteLength(JSON.stringify(exported.session)), unchanged: unchanged.unchanged, changed_preview_ok: proposal?.ok ?? false, proposed_changes: proposal?.changed ?? 0, affected: proposal ? proposal.affected.length + proposal.omittedAffected : 0, staged_refusals: Object.fromEntries(refused), preview_bytes: proposal ? Buffer.byteLength(JSON.stringify(proposal)) : 0, copied_bytes_unchanged: true, readonly: true, git_on_path: false, source_unchanged: true }));
} finally {
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  try { restore?.(); } finally { rmSync(scratch, { recursive: true, force: true }); }
}
