import { fingerprintValidationTree, readonlyValidationTree } from "./validation-tree.ts";
/** Validate committed public rows on a read-only, non-git copy; report counts only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { exportTodoSourceSelection, applyTodoSourceSelection } from "../index.ts";


const repo = resolve(process.argv[2] ?? ".");
const remote = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
assert.match(remote, /^https:\/\/github\.com\/unbraind\/pm-[a-z-]+(?:\.git)?$/);
const head = execFileSync("git", ["-C", repo, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
const scratch = mkdtempSync(join(tmpdir(), "todos-source-public-"));
const copied = join(scratch, "public"); mkdirSync(copied);
let restore: (() => void) | undefined;
try {
  const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", head, ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", copied], { input: archive });
  const nodeOnly = join(scratch, "node-only"); mkdirSync(nodeOnly);
  symlinkSync(process.execPath, join(nodeOnly, "node")); process.env.PATH = nodeOnly;
  restore = readonlyValidationTree(copied);
  process.env.GIT_CEILING_DIRECTORIES = dirname(copied);
  const before = fingerprintValidationTree(copied).digest, pmRoot = join(copied, ".agents", "pm");
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
  assert.equal(fingerprintValidationTree(copied).digest, before);
  console.log(JSON.stringify({ public_repository: remote.replace(/\.git$/, ""), head, items: items.length, selected: exported.manifest.session.entries.length, skipped: exported.skipped, files: exported.files.length, text_bytes: exported.files.reduce((sum,file) => sum + Buffer.byteLength(file.text), 0), manifest_bytes: Buffer.byteLength(JSON.stringify(exported.manifest)), baseline_proposed_ownerships: baseline.moved, move_preview_ok: preview.ok, duplicate_refusals: refusal.refusals.length, input_unchanged: true, git_repository: false, no_git_on_path: true, applied: 0 }));
} finally { try { restore?.(); } finally { rmSync(scratch, { recursive: true, force: true }); } }
