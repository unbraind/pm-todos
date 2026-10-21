/** Validate public tracker data on a disposable copy; never mutate the source. */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { listAllComplete, update } from "@unbrained/pm-cli/sdk";
import { createTodoEditingSession, applyTodoEditingSession } from "../index.ts";

/** Fingerprint durable item and history bytes, excluding generated runtime caches. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  /** Traverse only this supplied tracker and hash authoritative file types. */
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["runtime", "locks", "search", "extensions"].includes(entry.name)) continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith(".toon") || entry.name.endsWith(".jsonl") || entry.name === "settings.json") hash.update(readFileSync(file));
    }
  };
  visit(root);
  return hash.digest("hex");
}

const source = process.argv[2];
if (!source) throw new Error("Pass the public tracker directory to copy.");
const before = fingerprint(source);
const root = mkdtempSync(join(tmpdir(), "todos-public-session-"));
const pmRoot = join(root, "tracker");
process.env.GIT_CEILING_DIRECTORIES = dirname(root);
try {
  cpSync(source, pmRoot, { recursive: true, filter: path => !["runtime", "locks", "search", "extensions"].includes(path.split(/[\\/]/).at(-1) ?? "") });
  const items = (await listAllComplete({}, { pmRoot, noExtensions: true })).items;
  const eligible = items.filter(item => typeof item.title === "string" && item.title.length > 0);
  const { session, text } = createTodoEditingSession(eligible);
  const initial = fingerprint(pmRoot);
  const unchanged = await applyTodoEditingSession(pmRoot, session, text, { author: "validation-agent" });
  const replay = await applyTodoEditingSession(pmRoot, session, text, { author: "validation-agent" });
  const noOpBytesPreserved = initial === fingerprint(pmRoot);
  const omitted = await applyTodoEditingSession(pmRoot, session, "", { author: "validation-agent" });
  const selected = eligible.find(item => !item.assignee && item.status === "open");
  if (!selected) throw new Error("Public copy has no eligible open item for conflict validation.");
  await update(selected.id, { title: "Concurrent validation title", author: "validation-agent" }, { pmRoot });
  const edited = text.split("\n").map(line => line.endsWith(`pm-session:${selected.id}`) ? line.replace(selected.title, "External validation title") : line).join("\n");
  const conflict = await applyTodoEditingSession(pmRoot, session, edited, { author: "validation-agent" });
  const sourceUnchanged = before === fingerprint(source);
  const receipt = { items: items.length, exported: session.entries.length, textBytes: Buffer.byteLength(text), sidecarBytes: Buffer.byteLength(JSON.stringify(session)), unchanged: unchanged.unchanged, replayChanged: replay.changed, omitted: omitted.omitted, noOpBytesPreserved, conflictCount: conflict.refusalCount, conflictCode: conflict.refusals[0]?.code, sourceUnchanged };
  console.log(JSON.stringify(receipt));
  if (!unchanged.ok || !replay.ok || replay.changed || !noOpBytesPreserved || omitted.omitted !== items.length || conflict.refusals[0]?.code !== "field_conflict" || !sourceUnchanged) process.exitCode = 1;
} finally { rmSync(root, { recursive: true, force: true }); }
