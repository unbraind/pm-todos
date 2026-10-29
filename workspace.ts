/** Shared native schema context for every direct SDK path in this package. */
import type * as Core from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";

/** One source of truth for fields emitted and registered by pm-todos. */
export const TODO_ITEM_FIELDS: Parameters<ExtensionApi["registerItemFields"]>[0] = [
  { name: "todos_kv", type: "object", optional: true },
  { name: "todos_todotxt", type: "string", optional: true },
  { name: "todos_creation_date", type: "string", optional: true },
  { name: "todos_completion_date", type: "string", optional: true },
  { name: "todos_source_created_at", type: "string", optional: true },
  { name: "todos_source_updated_at", type: "string", optional: true },
  { name: "todos_source_file", type: "string", optional: true },
];
/** Host primitives required to keep direct reads and mutations in one workspace registry. */
export type TodoWorkspaceSdk = Pick<typeof Core, "runWithActiveExtensions" | "getActiveExtensionRegistrations">;
/** Preserve every registered extension field while retaining standalone package-field compatibility. */
export function todoExtensionFieldNames(core: Pick<TodoWorkspaceSdk, "getActiveExtensionRegistrations">): string[] {
  return [...new Set([...TODO_ITEM_FIELDS.map(field => field.name), ...(core.getActiveExtensionRegistrations()?.item_fields ?? []).flatMap(entry => entry.fields.map(field => field.name))])];
}
/** Activate the target workspace through the supported SDK, isolated from concurrent workspaces. */
export function withTodoWorkspace<T>(core: Pick<TodoWorkspaceSdk, "runWithActiveExtensions">, pmRoot: string, run: () => Promise<T>): Promise<T> {
  return core.runWithActiveExtensions({ path: pmRoot }, run);
}
