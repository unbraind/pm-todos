/** Bounded filesystem transport for the explicit source-selection SDK. */
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { applyTodoSourceSelection, exportTodoSourceSelection, parseTodoSourceManifest, TodoSourceError } from "./source-sessions.ts";

/** Reject nonregular or oversized files without following a final symlink. */
function read(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new TodoSourceError("invalid_input", "Use regular JSON and todo.txt files within the documented size bounds.");
    const value = readFileSync(fd, "utf8");
    if (Buffer.byteLength(value) > limit) throw new TodoSourceError("invalid_input", "Split the selection to stay within the documented size bounds.");
    return value;
  } finally { closeSync(fd); }
}
/** Resolve manifest filenames inside the explicitly supplied editing directory. */
function sourcePath(directory: string, file: string): string {
  const target = resolve(directory, file);
  const parent = realpathSync(dirname(target));
  if (parent !== directory && !parent.startsWith(directory + sep)) throw new TodoSourceError("source_scope", "Keep all selected files inside the editing directory, without external symlinks.");
  return target;
}
/** Filesystem transport only: the SDK owns schema, scope, planning and writes. */
export async function runTodoSourceCommand(ctx: CommandHandlerContext): Promise<unknown> {
  try {
    const action = ctx.args[0];
    const manifest = ctx.options.manifest, directory = ctx.options.directory, selection = ctx.options.selection;
    if (!["export", "preview", "apply"].includes(action) || typeof manifest !== "string" || !manifest.trim() || typeof directory !== "string" || !directory.trim() || (action === "export" && (typeof selection !== "string" || !selection.trim())) || (action !== "export" && selection !== undefined)) throw new TodoSourceError("invalid_input", "Use todos sources export --selection selection.json --manifest manifest.json --directory edits; then preview or apply with the manifest and directory.");
    const root = realpathSync(directory);
    if (action === "export") {
      const exported = await exportTodoSourceSelection(ctx.pm_root, JSON.parse(read(selection as string, 1024 * 1024)) as unknown);
      const outputs = [{ path: resolve(manifest), text: JSON.stringify(exported.manifest) + "\n" }, ...exported.files.map(file => ({ path: sourcePath(root, file.file), text: file.text }))];
      if (new Set(outputs.map(output => output.path)).size !== outputs.length) throw new TodoSourceError("source_scope", "Use a distinct manifest filename outside the selected source files.");
      try {
        for (const output of outputs) {
          const fd = openSync(output.path, "wx", 0o600);
          try {
            writeFileSync(fd, output.text);
          } finally { closeSync(fd); }
        }
      } catch {
        // Preserve created outputs too: a peer may already have edited them.
        // File-content equality cannot prove that nobody wrote since creation.
        throw new TodoSourceError("apply_failed", "Export uses fresh filenames exclusively. Inspect any retained partial files and choose fresh filenames before retrying.");
      }
      return { ok: true, files: exported.files.length, selected: exported.manifest.session.entries.length, skipped: exported.skipped, refusals: exported.refusals, digest: exported.manifest.digest };
    }
    const input = parseTodoSourceManifest(JSON.parse(read(manifest, 16 * 1024 * 1024)) as unknown);
    const files = input.sources.map(source => ({ file: source.file, text: read(sourcePath(root, source.file), 4 * 1024 * 1024) }));
    const author = process.env.PM_AUTHOR ?? "pm-todos";
    const result = await applyTodoSourceSelection(ctx.pm_root, input, files, { author, dryRun: action === "preview", ...(ctx.sdk ? { commit: options => ctx.sdk!.commitWorkspaceTransaction(options) } : {}) });
    if (!result.ok) process.exitCode = 1;
    return result;
  } catch (error) {
    process.exitCode = 1;
    const known = error instanceof TodoSourceError ? error : new TodoSourceError("invalid_input", "Check the selection, unchanged manifest, editing directory and readable regular input files.");
    return { ok: false, refusals: [{ code: known.code, remedy: known.remedy, ...(known.id ? { id: known.id } : {}) }] };
  }
}
