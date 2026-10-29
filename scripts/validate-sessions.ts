import { copyValidationTree, fingerprintValidationTree, VALIDATION_CACHE_NAMES } from "./validation-tree.ts";
/** Validate public tracker data on a disposable copy; never mutate the source. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { listAllComplete, update } from "@unbrained/pm-cli/sdk";
import { createTodoEditingSession, applyTodoEditingSession } from "../index.ts";


const source = process.argv[2];
if (!source) throw new Error("Pass the public tracker directory to copy.");
const before = fingerprintValidationTree(source, VALIDATION_CACHE_NAMES).digest;
const root = mkdtempSync(join(tmpdir(), "todos-public-session-"));
const pmRoot = join(root, "tracker");
process.env.GIT_CEILING_DIRECTORIES = dirname(root);
try {
  copyValidationTree(source, pmRoot, VALIDATION_CACHE_NAMES);
  const items = (await listAllComplete({}, { pmRoot })).items;
  const eligible = items.filter(item => typeof item.title === "string" && item.title.length > 0);
  const { session, text } = createTodoEditingSession(eligible);
  const initial = fingerprintValidationTree(pmRoot, VALIDATION_CACHE_NAMES).digest;
  const unchanged = await applyTodoEditingSession(pmRoot, session, text, { author: "validation-agent" });
  const replay = await applyTodoEditingSession(pmRoot, session, text, { author: "validation-agent" });
  const noOpBytesPreserved = initial === fingerprintValidationTree(pmRoot, VALIDATION_CACHE_NAMES).digest;
  const omitted = await applyTodoEditingSession(pmRoot, session, "", { author: "validation-agent" });
  const selected = eligible.find(item => !item.assignee && item.status === "open");
  if (!selected) throw new Error("Public copy has no eligible open item for conflict validation.");
  await update(selected.id, { title: "Concurrent validation title", author: "validation-agent" }, { pmRoot });
  const edited = text.split("\n").map(line => line.endsWith(`pm-session:${selected.id}`) ? line.replace(selected.title, "External validation title") : line).join("\n");
  const conflict = await applyTodoEditingSession(pmRoot, session, edited, { author: "validation-agent" });
  const sourceUnchanged = before === fingerprintValidationTree(source, VALIDATION_CACHE_NAMES).digest;
  const receipt = { items: items.length, exported: session.entries.length, textBytes: Buffer.byteLength(text), sidecarBytes: Buffer.byteLength(JSON.stringify(session)), unchanged: unchanged.unchanged, replayChanged: replay.changed, omitted: omitted.omitted, noOpBytesPreserved, conflictCount: conflict.refusalCount, conflictCode: conflict.refusals[0]?.code, sourceUnchanged };
  console.log(JSON.stringify(receipt));
  if (!unchanged.ok || !replay.ok || replay.changed || !noOpBytesPreserved || omitted.omitted !== session.entries.length || conflict.refusals[0]?.code !== "field_conflict" || !sourceUnchanged) process.exitCode = 1;
} finally { rmSync(root, { recursive: true, force: true }); }
