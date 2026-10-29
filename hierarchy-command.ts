/** Filesystem transport for revision-bound checklist repair sessions. */
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { applyTodoHierarchy, exportTodoHierarchy, TodoHierarchyError, type TodoHierarchyRelation } from "./hierarchy.ts";

/** Read bounded regular files without blocking on FIFOs or following final symlinks. */
function read(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw new Error();
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > limit) throw new Error();
    return text;
  } finally { closeSync(fd); }
}
/** Exclusively create review files; retain partial output because a peer may have edited it. */
function write(path: string, text: string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, text); } finally { closeSync(fd); }
}
/** Commands return host-rendered compact TOON/JSON with typed refusals and nonzero failure status. */
export async function runTodoHierarchyCommand(ctx: CommandHandlerContext): Promise<unknown> {
  try {
    const action = ctx.args[0], file = ctx.options.file, sidecar = ctx.options.session, selection = ctx.options.selection;
    if (!["export", "preview", "apply"].includes(action) || typeof file !== "string" || !file.trim() || typeof sidecar !== "string" || !sidecar.trim() || resolve(file) === resolve(sidecar) || (action === "export" ? typeof selection !== "string" || !selection.trim() : selection !== undefined || ctx.options.relation !== undefined)) throw new Error();
    if (action === "export") {
      const relation = ctx.options.relation ?? "parent";
      const result = await exportTodoHierarchy(ctx.pm_root, JSON.parse(read(selection as string, 256 * 1024)) as unknown, relation as TodoHierarchyRelation);
      write(sidecar, JSON.stringify(result.session) + "\n"); write(file, result.text);
      return { ok: true, selected: result.session.rows.length, skipped: result.skipped, refusals: result.refusals, digest: result.session.digest };
    }
    const result = await applyTodoHierarchy(ctx.pm_root, JSON.parse(read(sidecar, 1024 * 1024)) as unknown, read(file, 1024 * 1024), { author: process.env.PM_AUTHOR ?? "pm-todos", dryRun: action === "preview", ...(ctx.sdk ? { read: () => ctx.sdk!.client.listAllComplete() } : {}) });
    if (!result.ok) process.exitCode = 1;
    return result;
  } catch (error) {
    process.exitCode = 1;
    if (error instanceof TodoHierarchyError) return { ok: false, refusals: [error.detail] };
    return { ok: false, refusals: [{ code: "invalid_input", remedy: "Use todos hierarchy export --selection ids.json --file checklist.md --session hierarchy.json [--relation parent|blocked_by]; preview/apply use the two distinct regular files. Export requires fresh filenames. Inspect retained partial files before retrying." }] };
  }
}
