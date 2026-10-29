/** Validate committed public rows on a read-only, non-git copy; report counts only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { exportTodoSourceSelection, applyTodoSourceSelection } from "../index.ts";

/** Full copy fingerprint includes paths and every file, including unexpected generated state. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  /** Visit just this disposable committed tracker, without following symlinks. */
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else { assert.ok(entry.isFile()); hash.update(file.slice(root.length)); hash.update(readFileSync(file)); }
    }
  }
  visit(root); return hash.digest("hex");
}
/** Only the disposable copy is made immutable, and writable again for cleanup. */
function permissions(root: string, readonly: boolean): void {
  chmodSync(root, 0o755);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) permissions(file, readonly); else chmodSync(file, readonly ? 0o444 : 0o644);
  }
  if (readonly) chmodSync(root, 0o555);
}

const repo = resolve(process.argv[2] ?? ".");
const remote = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
assert.match(remote, /^https:\/\/github\.com\/unbraind\/pm-[a-z-]+(?:\.git)?$/);
const head = execFileSync("git", ["-C", repo, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
const scratch = mkdtempSync(join(tmpdir(), "todos-source-public-"));
const copied = join(scratch, "public"); mkdirSync(copied);
try {
  const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", head, ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", copied], { input: archive });
  const nodeOnly = join(scratch, "node-only"); mkdirSync(nodeOnly);
  symlinkSync(process.execPath, join(nodeOnly, "node")); process.env.PATH = nodeOnly;
  permissions(copied, true);
  process.env.GIT_CEILING_DIRECTORIES = dirname(copied);
  const before = fingerprint(copied), pmRoot = join(copied, ".agents", "pm");
  const items = (await listAllComplete({}, { pmRoot })).items;
  assert.ok(items.length && items.length <= 1000);
  const selection = { sources: ["one.txt", "two.txt"].map((file, index) => ({ file, ids: items.filter((_, n) => n % 2 === index).map(item => item.id) })) };
  const exported = await exportTodoSourceSelection(pmRoot, selection);
  const baseline = await applyTodoSourceSelection(pmRoot, exported.manifest, exported.files, { author: "public-validator", dryRun: true });
  assert.equal(baseline.ok, true);
  const moved = structuredClone(exported.files), id = exported.manifest.sources[0].rows[0].id;
  const line = moved[0].text.split("\n").find(line => line.endsWith(`pm-session:${id}`))!;
  moved[0].text = moved[0].text.split("\n").filter(row => row !== line).join("\n"); moved[1].text += line + "\n";
  const preview = await applyTodoSourceSelection(pmRoot, exported.manifest, moved, { author: "public-validator", dryRun: true });
  assert.equal(preview.ok, true);
  const duplicate = structuredClone(exported.files); duplicate[1].text += line + "\n";
  const refusal = await applyTodoSourceSelection(pmRoot, exported.manifest, duplicate, { author: "public-validator", dryRun: true });
  assert.equal(refusal.refusals[0].code, "duplicate_ownership");
  assert.equal(fingerprint(copied), before);
  console.log(JSON.stringify({ public_repository: remote.replace(/\.git$/, ""), head, items: items.length, selected: exported.manifest.session.entries.length, skipped: exported.skipped, files: exported.files.length, text_bytes: exported.files.reduce((sum,file) => sum + Buffer.byteLength(file.text), 0), manifest_bytes: Buffer.byteLength(JSON.stringify(exported.manifest)), baseline_proposed_ownerships: baseline.moved, move_preview_ok: preview.ok, duplicate_refusals: refusal.refusals.length, input_unchanged: true, git_repository: false, no_git_on_path: true, applied: 0 }));
} finally { permissions(copied, false); rmSync(scratch, { recursive: true, force: true }); }
