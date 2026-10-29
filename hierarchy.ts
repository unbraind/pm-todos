import { todoExtensionFieldNames, withTodoWorkspace, type TodoWorkspaceSdk } from "./workspace.ts";
/** Reviewed Markdown indentation interpreted through native relationship APIs. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type * as Core from "@unbrained/pm-cli/sdk";
import type { ItemDocument, PmSettings } from "@unbrained/pm-cli/sdk";

/** Public peer primitives, injectable by hosts without resolving executable paths. */
export type TodoHierarchySdk = TodoWorkspaceSdk & Pick<typeof Core, "listAllComplete" | "readSettings" | "locateItem" | "readLocatedItem" | "readHistoryEntries" | "getHistoryPath" | "verifyHistoryEntries" | "replayHistoryToTarget" | "canonicalDocument" | "stableUpsertValue" | "resolveItemTypeRegistry" | "resolveRuntimeStatusRegistry" | "statusIsTerminal" | "RelationshipGraph" | "hierarchyAncestors" | "hierarchyDescendants" | "orderingPredecessors" | "orderingSuccessors" | "assertHierarchyMutationAllowed" | "collectNewOrderingCycleWarnings" | "resolveCanonicalRelationshipKind" | "normalizeParentReferenceValue" | "isPlaceholderReferenceToken" | "mutateItem" | "nowIso" | "assertRelationshipEdgeAllowed" | "deriveMutationTransactionId">;
/** Indentation either manages a structural parent or one explicit legacy blocker. */
export type TodoHierarchyRelation = "parent" | "blocked_by";
/** Immutable, revision-bound baseline for the selected identities and their topology. */
export interface TodoHierarchySession {
  version: 1;
  relation: TodoHierarchyRelation;
  rows: { id: string; revision: string; target: string | null }[];
  digest: string;
}
/** No native titles, paths or values are repeated in refusal diagnostics. */
export interface TodoHierarchyRefusal {
  code: "invalid_input" | "invalid_session" | "orphan_row" | "ambiguous_indent" | "duplicate_id" | "unknown_id" | "missing_item" | "stale_revision" | "invalid_history" | "cycle" | "native_refusal";
  remedy: string;
  id?: string;
  line?: number;
  nativeCode?: string;
}
/** Bounded relation-only output, with affected topology and explicit pagination. */
export interface TodoHierarchyResult {
  ok: boolean;
  selected: number;
  changed: number;
  applied: number;
  unchanged: number;
  changes: { id: string; relation: TodoHierarchyRelation; before: string | null; after: string | null }[];
  affected: string[];
  omittedChanges: number;
  omittedAffected: number;
  refusals: TodoHierarchyRefusal[];
}
/** Trusted application controls; observers support deterministic ordinary-writer tests. */
export interface TodoHierarchyOptions {
  author: string;
  dryRun?: boolean;
  sdk?: TodoHierarchySdk;
  read?: () => ReturnType<TodoHierarchySdk["listAllComplete"]>;
  onBoundary?: (boundary: "planned" | "before_write" | "locked" | "after_write", id?: string) => void | Promise<void>;
}
/** Exported sidecars and Markdown use the same strict schema as preview/apply. */
export interface TodoHierarchyExport { session: TodoHierarchySession; text: string; skipped: number; refusals: TodoHierarchyRefusal[] }
interface Snapshot { document: ItemDocument; history: Awaited<ReturnType<TodoHierarchySdk["readHistoryEntries"]>>; revision: string }
interface Row { id: string; target: string | null; line: number }
const MAX_ROWS = 1000, MAX_BYTES = 1024 * 1024, OUTPUT_ROWS = 40;

/** Stable native revision includes the growing history length and its verified head. */
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Resolve the supported peer export lazily; hosts can supply the same public SDK. */
function sdk(injected?: TodoHierarchySdk): TodoHierarchySdk { return injected ?? createRequire(import.meta.url)("@unbrained/pm-cli/sdk") as TodoHierarchySdk; }
/** Typed refusal thrown internally and redacted at the exported boundary. */
export class TodoHierarchyError extends Error {
  /** Redacted stable category and remedy for export/schema failures. */
  readonly detail: TodoHierarchyRefusal;
  /** Retain a typed refusal without raw tracker or filesystem error details. */
  constructor(detail: TodoHierarchyRefusal) { super(detail.code); this.detail = detail; }
}
/** Refuse before any mutation, keeping task content out of diagnostics. */
function refuse(code: TodoHierarchyRefusal["code"], remedy: string, id?: string, line?: number): never { throw new TodoHierarchyError({ code, remedy, ...(id ? { id } : {}), ...(line ? { line } : {}) }); }
/** Inspect only plain data properties; arrays must be dense and have no extra keys. */
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)) || Object.entries(descriptors).some(([key, entry]) => !keys.includes(key) || !entry.enumerable || !Object.hasOwn(entry, "value"))) throw new Error();
  return value as Record<string, unknown>;
}
/** Strict bounded transport array, shared by selection and session validation. */
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > MAX_ROWS || Reflect.ownKeys(value).length !== value.length + 1) throw new Error();
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d?.enumerable || !Object.hasOwn(d, "value")) throw new Error(); }
  return value;
}
/** Canonical stable ids are the only identities admitted to new sidecars. */
function identity(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error(); }
/** One strict request schema validates all untrusted input before SDK access. */
function request(input: unknown): { action: "export"; ids: string[]; relation: TodoHierarchyRelation } | { action: "apply"; session: TodoHierarchySession; text: string } {
  try {
    const action = Object.getOwnPropertyDescriptor(input, "action")?.value;
    if (action === "export") {
      const data = object(input, ["action", "ids", "relation"]);
      if (data.relation !== "parent" && data.relation !== "blocked_by") throw new Error();
      const ids = array(data.ids); ids.forEach(identity);
      if (new Set(ids).size !== ids.length) throw new Error();
      return { action, ids: [...ids] as string[], relation: data.relation };
    }
    const data = object(input, ["action", "session", "text"]);
    if (action !== "apply" || typeof data.text !== "string" || Buffer.byteLength(data.text) > MAX_BYTES || data.text.split(/\r?\n/).length > MAX_ROWS + 1) throw new Error();
    const session = object(data.session, ["version", "relation", "rows", "digest"]);
    if (session.version !== 1 || (session.relation !== "parent" && session.relation !== "blocked_by")) throw new Error();
    const ids = new Set<string>();
    for (const value of array(session.rows)) {
      const row = object(value, ["id", "revision", "target"]); identity(row.id);
      if (row.target !== null) identity(row.target);
      if (typeof row.revision !== "string" || !/^[a-f0-9]{64}$/.test(row.revision) || ids.has(row.id)) throw new Error();
      ids.add(row.id);
    }
    if (session.digest !== hash([session.version, session.relation, session.rows])) refuse("invalid_session", "Export a fresh hierarchy sidecar and keep it unchanged.");
    return { action, session: structuredClone(data.session) as TodoHierarchySession, text: data.text };
  } catch (error) {
    if (error instanceof TodoHierarchyError) throw error;
    return refuse("invalid_input", "Use 1..1000 unique marked rows, a version 1 sidecar, dense arrays and at most 1 MiB of Markdown.");
  }
}
/** Validate sidecars without accessing a tracker, including producer/validator agreement. */
export function parseTodoHierarchySession(value: unknown): TodoHierarchySession {
  const parsed = request({ action: "apply", session: value, text: "" });
  if (parsed.action !== "apply") throw new Error("unreachable");
  return parsed.session;
}
/** Parse indentation only; titles and checkbox state never choose or modify an identity. */
function rows(text: string, session: TodoHierarchySession): Row[] {
  const known = new Set(session.rows.map(row => row.id)), seen = new Set<string>(), stack: string[] = [], result: Row[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    // Disjoint scans keep malformed long whitespace rows linear. A title and
    // whitespace quantifier must never compete for the same character span.
    const prefix = /^( *)(?:-|\*) \[[ xX]\] /.exec(raw), tail = raw.trimEnd();
    const marker = "<!-- pm-session:", ending = " -->", markerIndex = tail.lastIndexOf(marker);
    const id = markerIndex < 0 ? "" : tail.slice(markerIndex + marker.length, -ending.length);
    const title = prefix && markerIndex >= prefix[0].length ? tail.slice(prefix[0].length, markerIndex).trimEnd() : "";
    if (!prefix || !tail.endsWith(ending) || !/^[a-zA-Z0-9_-]{1,160}$/.test(id) || !/\s/.test(tail[markerIndex - 1] ?? "") || !title.trim() || /[\r\n\u2028\u2029]/.test(title) || /<!--\s*pm-session:/.test(title)) refuse("orphan_row", "Keep exactly one exported pm-session marker on each checklist row; use pm create for new rows.", undefined, index + 1);
    const depth = prefix[1].length / 2;
    if (prefix[1].length % 2 || depth > 100 || depth > stack.length) refuse("ambiguous_indent", "Use two spaces per level and retain the immediately preceding marked ancestor.", id, index + 1);
    if (!known.has(id)) refuse("unknown_id", "Export a selection including this exact identity; titles are never matched.", id, index + 1);
    if (seen.has(id)) refuse("duplicate_id", "Keep one row per stable identity.", id, index + 1);
    seen.add(id); stack.length = depth;
    result.push({ id, target: stack.at(-1) ?? null, line: index + 1 }); stack.push(id);
  }
  for (const id of known) if (!seen.has(id)) refuse("orphan_row", "Retain every selected row; omission never deletes an item or selects another parent.", id);
  return result;
}
/** History, not content equality or a cached event index, certifies a target revision. */
async function snapshot(core: TodoHierarchySdk, pmRoot: string, settings: PmSettings, id: string): Promise<Snapshot> {
  try {
    const located = await core.locateItem(pmRoot, id, settings.id_prefix, settings.item_format, core.resolveItemTypeRegistry(settings, core.getActiveExtensionRegistrations()).type_to_folder);
    if (!located) refuse("missing_item", "A selected row or parent was deleted. Restore it or export and review a fresh selection.", id);
    const { document } = await core.readLocatedItem(located, { schema: settings.schema, extensionFieldNames: todoExtensionFieldNames(core) });
    const history = await core.readHistoryEntries(core.getHistoryPath(pmRoot, id), id);
    if (!history.length || !core.verifyHistoryEntries(history, document).ok) refuse("invalid_history", "Inspect pm health and preserve the damaged native history before retrying.", id);
    return { document, history, revision: hash([history.length, history.at(-1)?.record_hash, history]) };
  } catch (error) {
    if (error instanceof TodoHierarchyError) throw error;
    return refuse("invalid_history", "Inspect this unreadable native row and preserve its history before retrying.", id);
  }
}
/** Native relationship comparison is normalized by the SDK graph, including legacy spellings. */
function target(core: TodoHierarchySdk, document: ItemDocument, relation: TodoHierarchyRelation): string | null {
  const blockers = relation === "blocked_by" ? (document.metadata.dependencies ?? []).filter(dep => core.resolveCanonicalRelationshipKind(dep.kind) === "blocked_by") : [];
  const distinct = new Set(blockers.map(dep => dep.id));
  const scalar = document.metadata[relation];
  if (relation === "blocked_by" && (blockers.length > 1 || (distinct.size && typeof scalar === "string" && !distinct.has(scalar)))) refuse("invalid_input", "This row has multiple or divergent blockers. Use native dependency commands to review it; one indentation edge cannot represent that set.", document.metadata.id);
  const raw = relation === "blocked_by" ? blockers[0]?.id ?? scalar : scalar;
  if (typeof raw !== "string" || !raw.trim() || core.isPlaceholderReferenceToken(raw.trim())) return null;
  return core.normalizeParentReferenceValue(raw);
}
/** Produce the exact native field delta used by both graph preview and locked persistence. */
function propose(core: TodoHierarchySdk, document: ItemDocument, relation: TodoHierarchyRelation, next: string | null, author: string, timestamp: string): string[] {
  const previous = target(core, document, relation);
  if (previous === next) return [];
  const fields: string[] = [relation];
  if (next === null) delete document.metadata[relation]; else document.metadata[relation] = next;
  if (relation === "blocked_by") {
    const dependencies = (document.metadata.dependencies ?? []).filter(dep => !(core.resolveCanonicalRelationshipKind(dep.kind) === "blocked_by" && dep.id === previous));
    if (next) {
      const definition = core.assertRelationshipEdgeAllowed(document.metadata.id, next, "blocked_by");
      dependencies.push({ id: next, kind: definition.kind, author, created_at: timestamp, source_kind: "pm-todos:hierarchy", author_source: "asserted" });
    }
    if (dependencies.length) document.metadata.dependencies = dependencies; else delete document.metadata.dependencies;
    fields.push("dependencies");
  }
  return fields;
}
/** Exclude only native fields a blocker/parent update is allowed to alter. */
function preserved(core: TodoHierarchySdk, document: ItemDocument, relation: TodoHierarchyRelation): string {
  const canonical = core.canonicalDocument(document, { extensionFieldNames: todoExtensionFieldNames(core) });
  const removed = new Set([relation, "updated_at", ...(relation === "blocked_by" ? ["dependencies"] : [])]);
  return core.stableUpsertValue({ body: canonical.body, metadata: Object.fromEntries(Object.entries(canonical.metadata).filter(([key]) => !removed.has(key))) });
}
/** Accept replay only when one exact native history event owns the full delta from the expected revision. */
function checkRevision(core: TodoHierarchySdk, current: Snapshot, row: TodoHierarchySession["rows"][number], relation: TodoHierarchyRelation, next: string | null, marker: string): void {
  if (current.revision === row.revision) return;
  const beforeHistory = current.history.slice(0, -1), last = current.history.at(-1)!;
  if (beforeHistory.length && hash([beforeHistory.length, beforeHistory.at(-1)?.record_hash, beforeHistory]) === row.revision && last.op === "update" && last.message === marker && target(core, current.document, relation) === next) {
    const before = core.replayHistoryToTarget(current.history, current.history.length - 2) as ItemDocument;
    if (preserved(core, before, relation) === preserved(core, current.document, relation)) {
      if (relation === "parent") return;
      const old = row.target;
      const kept = (document: ItemDocument) => (document.metadata.dependencies ?? []).filter(dep => !(core.resolveCanonicalRelationshipKind(dep.kind) === "blocked_by" && [old, next].includes(dep.id)));
      const edges = (current.document.metadata.dependencies ?? []).filter(dep => core.resolveCanonicalRelationshipKind(dep.kind) === "blocked_by" && [old, next].includes(dep.id));
      if (core.stableUpsertValue(kept(before)) === core.stableUpsertValue(kept(current.document)) && edges.length === (next ? 1 : 0) && (!next || (edges[0].id === next && edges[0].source_kind === "pm-todos:hierarchy" && edges[0].author === last.author && edges[0].author_source === "asserted" && Number.isFinite(Date.parse(edges[0].created_at ?? ""))))) return;
    }
  }
  refuse("stale_revision", "A target changed since export, including ABA edits. Export again and review the current topology before retrying.", row.id);
}
/** Count checks apply to every emitted receipt, including refusals. */
function receipt(result: TodoHierarchyResult): TodoHierarchyResult {
  for (const field of ["selected", "changed", "applied", "unchanged", "omittedChanges", "omittedAffected"] as const) if (!Number.isSafeInteger(result[field]) || result[field] < 0 || result[field] > MAX_ROWS) throw new Error("Invalid hierarchy receipt");
  return result;
}
/** Export an explicit selection; malformed native display records fail alone. */
export async function exportTodoHierarchy(pmRoot: string, ids: unknown, relation: TodoHierarchyRelation = "parent", injected?: TodoHierarchySdk): Promise<TodoHierarchyExport> {
  const parsed = request({ action: "export", ids, relation });
  if (parsed.action !== "export") throw new Error("unreachable");
  const core = sdk(injected);
  return withTodoWorkspace(core, pmRoot, async () => {
    const settings = await core.readSettings(pmRoot), registry = core.resolveRuntimeStatusRegistry(settings.schema);
    const selected: { row: TodoHierarchySession["rows"][number]; title: string; done: boolean }[] = [], refusals: TodoHierarchyRefusal[] = [];
    let skipped = 0;
    for (const id of parsed.ids) {
      try {
        const current = await snapshot(core, pmRoot, settings, id), title = current.document.metadata.title;
        if (current.document.metadata.id !== id || typeof title !== "string" || !title.trim() || /[\r\n\u2028\u2029]|<!--\s*pm-session:/.test(title) || title.length > 4096) refuse("invalid_input", "Exclude this display row and use native JSON for it; other selected rows remain exportable.", id);
        selected.push({ row: { id, revision: current.revision, target: target(core, current.document, relation) }, title, done: core.statusIsTerminal(current.document.metadata.status, registry) });
      } catch (error) {
        if (!(error instanceof TodoHierarchyError)) throw error;
        skipped++; if (refusals.length < OUTPUT_ROWS) refusals.push(error.detail);
      }
    }
    // A skipped/unselected prerequisite cannot authorize any dependent row.
    // Prune only that dependent closure; independent selected records still export.
    let pruned = true;
    while (pruned) {
      pruned = false;
      for (let index = selected.length - 1; index >= 0; index--) {
        const entry = selected[index];
        if (entry.row.target && !selected.some(candidate => candidate.row.id === entry.row.target)) {
          selected.splice(index, 1); skipped++; pruned = true;
          if (refusals.length < OUTPUT_ROWS) refusals.push({ code: "orphan_row", id: entry.row.id, remedy: "Include the readable native parent/blocker before exporting this dependent row." });
        }
      }
    }
    if (!selected.length) refuse("invalid_input", "Select at least one readable native item with a single-line title.");
    const emitted = new Set<string>();
    const lines: string[] = [];
    /** Emit selected ancestors first while never inventing an unselected parent from a title. */
    const emit = (entry: typeof selected[number], path: Set<string>): void => {
      if (emitted.has(entry.row.id)) return;
      if (path.has(entry.row.id)) refuse("cycle", "Repair the existing selected relationship cycle with native pm commands first.", entry.row.id);
      path.add(entry.row.id);
      const parent = selected.find(candidate => candidate.row.id === entry.row.target);
      if (parent) emit(parent, path);
      emitted.add(entry.row.id); path.delete(entry.row.id);
    };
    selected.forEach(entry => emit(entry, new Set()));
    /** Stable DFS keeps siblings adjacent so indentation encodes the actual selected ancestry. */
    const walk = (entry: typeof selected[number], depth: number): void => {
      if (depth > 100) refuse("ambiguous_indent", "Export a shallower selection with at most 100 hierarchy levels.", entry.row.id);
      lines.push(`${"  ".repeat(depth)}- [${entry.done ? "x" : " "}] ${entry.title} <!-- pm-session:${entry.row.id} -->`);
      for (const child of selected) if (child.row.target === entry.row.id) walk(child, depth + 1);
    };
    for (const entry of selected) if (!entry.row.target || !selected.some(candidate => candidate.row.id === entry.row.target)) walk(entry, 0);
    const session: TodoHierarchySession = { version: 1, relation, rows: selected.map(entry => entry.row), digest: "" };
    session.digest = hash([session.version, session.relation, session.rows]);
    const text = lines.join("\n") + "\n";
    request({ action: "apply", session, text }); rows(text, session);
    return { session, text, skipped, refusals };
  });
}
/** Preview and apply share every parse, topology, revision and native validation decision. No frozen plan is replayed. */
export async function applyTodoHierarchy(pmRoot: string, session: unknown, text: unknown, options: TodoHierarchyOptions): Promise<TodoHierarchyResult> {
  let result: TodoHierarchyResult = { ok: false, selected: 0, changed: 0, applied: 0, unchanged: 0, changes: [], affected: [], omittedChanges: 0, omittedAffected: 0, refusals: [] };
  try {
    const parsed = request({ action: "apply", session, text });
    if (parsed.action !== "apply") throw new Error("unreachable");
    if (typeof options.author !== "string" || !options.author.trim() || options.author.length > 160 || (options.dryRun !== undefined && typeof options.dryRun !== "boolean")) refuse("invalid_input", "Supply a nonempty author of at most 160 characters and an optional boolean dryRun.");
    const core = sdk(options.sdk);
    return await withTodoWorkspace(core, pmRoot, async () => {
      const settings = await core.readSettings(pmRoot), registry = core.resolveRuntimeStatusRegistry(settings.schema);
      const intent = rows(parsed.text, parsed.session), relation = parsed.session.relation;
      const transaction = core.deriveMutationTransactionId(JSON.stringify(["todos-hierarchy-v1", parsed.session.digest, intent.map(row => [row.id, row.target]).sort()]));
      const marker = (id: string) => `pm-todos-hierarchy-v1:${transaction}:${id}`;
      const baseline = new Map(parsed.session.rows.map(row => [row.id, row]));
      result.selected = intent.length;
      /** Validate the same native transition for the final graph, each scheduled prefix and the locked write. */
      const validate = (before: ItemDocument["metadata"][], after: ItemDocument["metadata"][], id: string) => {
        try { core.assertHierarchyMutationAllowed(before, after, id, status => core.statusIsTerminal(status, registry)); }
        catch { refuse("cycle", "The proposal violates native hierarchy topology. Review parent/dependency edges and export again.", id); }
        if (core.collectNewOrderingCycleWarnings(before, after, id).length) refuse("cycle", "The proposal creates a native dependency cycle. Remove the conflicting relation and preview again.", id);
      };
      /** Re-read all selected targets and relevant native topology before each decision/write. */
      const plan = async () => {
        const current = new Map<string, Snapshot>();
        for (const row of intent) {
          const value = await snapshot(core, pmRoot, settings, row.id);
          checkRevision(core, value, baseline.get(row.id)!, relation, row.target, marker(row.id)); current.set(row.id, value);
        }
        const complete = options.read ? await options.read() : await core.listAllComplete({}, { pmRoot });
        const before = complete.items.map(item => current.get(item.id)?.document.metadata ?? item);
        const after = before.map(item => {
          const row = intent.find(row => row.id === item.id);
          if (!row) return item;
          const document = structuredClone(current.get(row.id)!.document);
          propose(core, document, relation, row.target, options.author, core.nowIso());
          return document.metadata;
        });
        for (const row of intent) if (row.target && !current.has(row.target)) refuse("missing_item", "The proposed parent must be a selected, existing marked row.", row.id);
        const changes = intent.filter(row => target(core, current.get(row.id)!.document, relation) !== row.target).map(row => ({ id: row.id, relation, before: target(core, current.get(row.id)!.document, relation), after: row.target }));
        for (const row of changes) validate(before, after, row.id);
        // A valid final graph is insufficient: ownership, storage or interruption
        // can stop after any write. Find an order whose EVERY durable prefix is
        // valid, without temporary detach writes or relying on later compensation.
        const desired = new Map(after.map(item => [item.id, item]));
        const pending = [...changes], writes: typeof changes = [];
        let intermediate = before;
        while (pending.length) {
          let accepted = false;
          for (const [index, change] of pending.entries()) {
            const next = intermediate.map(item => item.id === change.id ? desired.get(item.id)! : item);
            try { validate(intermediate, next, change.id); }
            catch (error) {
              if (!(error instanceof TodoHierarchyError) || error.detail.code !== "cycle") throw error;
              continue;
            }
            writes.push(change); pending.splice(index, 1); intermediate = next; accepted = true; break;
          }
          if (!accepted) refuse("cycle", "No fully validated sequence of native item writes was found. Review conflicting relations through native commands, then export again.", pending[0].id);
        }
        const graphs = changes.length ? [core.RelationshipGraph.fromItems(before), core.RelationshipGraph.fromItems(after)] : [], affected = new Set<string>();
        for (const change of changes) {
          affected.add(change.id);
          for (const id of [change.before, change.after]) if (id) affected.add(id);
          // Include only ancestors and descendants of changed rows, never unrelated siblings.
          for (const graph of graphs) for (const traversal of relation === "parent" ? [core.hierarchyAncestors, core.hierarchyDescendants] : [core.orderingPredecessors, core.orderingSuccessors]) {
            const related = traversal(graph, change.id, { limit: MAX_ROWS });
            if (related.meta.truncated) refuse("invalid_input", "Narrow the affected topology to at most 1000 nodes.", change.id);
            related.value.forEach(id => affected.add(id));
          }
        }
        if (affected.size > MAX_ROWS) refuse("invalid_input", "Narrow the affected topology to at most 1000 nodes.");
        return { current, changes, writes, before, desired, affected: [...affected].sort() };
      };
      const initial = await plan();
      result = { ...result, ok: true, changed: initial.changes.length, unchanged: intent.length - initial.changes.length, changes: initial.changes.slice(0, OUTPUT_ROWS), omittedChanges: Math.max(0, initial.changes.length - OUTPUT_ROWS), affected: initial.affected.slice(0, OUTPUT_ROWS), omittedAffected: Math.max(0, initial.affected.length - OUTPUT_ROWS) };
      await options.onBoundary?.("planned");
      if (options.dryRun) return receipt(result);
      for (const change of initial.writes) {
        await options.onBoundary?.("before_write", change.id);
        const fresh = await plan();
        if (!fresh.changes.some(row => row.id === change.id)) continue;
        // Ordinary writers share this native item lock. Other topology targets are
        // re-read inside it; their last-read-to-write window remains documented.
        const written = await core.mutateItem({ pmRoot, settings, id: change.id, op: "update", author: options.author, message: marker(change.id), skipNoop: true, extensionFieldNames: todoExtensionFieldNames(core),
          async mutate(document) {
            await options.onBoundary?.("locked", change.id);
            const lockedPlan = await plan();
            const locked = await snapshot(core, pmRoot, settings, change.id);
            checkRevision(core, locked, baseline.get(change.id)!, relation, change.after, marker(change.id));
            if (core.stableUpsertValue(core.canonicalDocument(document, { extensionFieldNames: todoExtensionFieldNames(core) })) !== core.stableUpsertValue(core.canonicalDocument(locked.document, { extensionFieldNames: todoExtensionFieldNames(core) }))) refuse("stale_revision", "The native locked document differs from the verified SDK revision. Preview again.", change.id);
            // The live graph may now need a different order. Validate THIS write,
            // rather than assuming the remaining final graph makes it safe.
            validate(lockedPlan.before, lockedPlan.before.map(item => item.id === change.id ? lockedPlan.desired.get(item.id)! : item), change.id);
            return { changedFields: propose(core, document, relation, change.after, options.author, core.nowIso()) };
          },
        });
        if (written.changedFields.length) result.applied++;
        await options.onBoundary?.("after_write", change.id);
      }
      await plan();
      return receipt(result);
    });
  } catch (error) {
    return receipt({ ...result, ok: false, refusals: [error instanceof TodoHierarchyError ? error.detail : { code: "native_refusal", remedy: "Inspect native pm ownership, workflow and topology constraints. Preserve any applied rows and export a fresh preview before retrying." }] });
  }
}
