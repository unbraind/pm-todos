/** Explicit cross-file ownership; core owns item storage, leases and transaction journals. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type * as CoreSdk from "@unbrained/pm-cli/sdk";
import type { ItemDocument, PmSettings, RuntimeStatusRegistry, WorkspaceTransactionStep, WorkspaceTransactionJsonValue, CommitWorkspaceTransactionOptions } from "@unbrained/pm-cli/sdk";
import { createTodoEditingSession, planTodoEditingSession, normalizeTodoEditingText, type TodoEditingSession, type TodoSessionPatch } from "./sessions.ts";
import type { PmItem } from "./index.ts";

/** Public SDK primitives injectable by standalone callers; never discover a host via argv. */
export type TodoSourceSdk = Pick<typeof CoreSdk, "acquireLockLease" | "readSettings" | "locateItem" | "readLocatedItem" | "readHistoryEntries" | "getHistoryPath" | "verifyHistoryEntries" | "mutateItem" | "commitWorkspaceTransaction" | "deriveMutationTransactionId" | "resolveRuntimeStatusRegistry" | "resolveItemTypeRegistry" | "replayHistoryToTarget" | "applyHistoryPatch" | "canonicalDocument" | "stableUpsertValue">;
/** An explicit, disjoint initial selection, bounded to 32 files and 1000 rows. */
export interface TodoSourceSelection { sources: { file: string; ids: string[] }[] }
/** Editable content is supplied separately from the immutable manifest. */
export interface TodoSourceFile { file: string; text: string }
/** Native revision and previous ownership of an identified row. */
export interface TodoSourceRow { id: string; revision: string; owner: string | null }
/** A versioned source manifest binds every baseline identity to exactly one logical file. */
export interface TodoSourceManifest {
  version: 1;
  sources: { file: string; rows: TodoSourceRow[] }[];
  session: TodoEditingSession;
  digest: string;
}
/** Export retains valid records when another selected record cannot be represented. */
export interface TodoSourceExport {
  manifest: TodoSourceManifest;
  files: TodoSourceFile[];
  skipped: number;
  refusals: TodoSourceRefusal[];
}
/** Typed, bounded refusals contain no task values or operator paths. */
export type TodoSourceCode = "invalid_input" | "duplicate_ownership" | "source_scope" | "missing_row" | "foreign_owner" | "stale_revision" | "invalid_history" | "session_refused" | "busy" | "apply_failed" | "superseded" | "sdk_unavailable";
/** One refusal and an actionable remedy, without echoing untrusted input. */
export interface TodoSourceRefusal { code: TodoSourceCode; remedy: string; id?: string }
/** Compact receipt; counts are finite safe integers in 0..1000, except files in 0..32. */
export interface TodoSourceResult {
  ok: boolean;
  files: number;
  selected: number;
  changed: number;
  applied: number;
  moved: number;
  unchanged: number;
  refusals: TodoSourceRefusal[];
  transaction?: string;
}
/** Export failures are typed too; apply converts these to compact receipts. */
export class TodoSourceError extends Error {
  /** Stable category used by agents to choose recovery. */
  readonly code: TodoSourceCode;
  /** A next action safe to display in public receipts. */
  readonly remedy: string;
  /** Known tracker identity, never an operator path. */
  readonly id?: string;
  /** Construct a redacted refusal; raw SDK exceptions stay in the local cause chain. */
  constructor(code: TodoSourceCode, remedy: string, id?: string) {
    super(`${code}: ${remedy}`);
    this.code = code; this.remedy = remedy; this.id = id;
  }
}
/** Export and apply use one schema, including the producers' own output. */
type Request = { action: "export"; selection: TodoSourceSelection } | { action: "apply"; manifest: TodoSourceManifest; files: TodoSourceFile[] };
interface Snapshot { document: ItemDocument; history: Awaited<ReturnType<TodoSourceSdk["readHistoryEntries"]>>; revision: string }
const EXTENSIONS = ["todos_todotxt", "todos_kv", "todos_creation_date", "todos_completion_date", "todos_source_file"];
const FIELD_NAMES = ["title", "priority", "tags", "deadline", "todos_creation_date", "todos_completion_date", "todos_kv", "todos_todotxt", "status"];
const WRITE_FIELDS = new Set([...FIELD_NAMES.filter(field => field !== "status"), "todos_source_file"]);
const MAX_BYTES = 4 * 1024 * 1024;

/** Canonical JSON digest for immutable manifests and native history revisions. */
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Keep baseline and recovery anchors identical, including legacy native history records. */
function historyRevision(history: Snapshot["history"]): string {
  return hash([history.length, history.at(-1)?.record_hash, history]);
}
/** Resolve only the declared public peer export, lazily, using Node's supported module loader. */
function sdk(injected?: TodoSourceSdk): TodoSourceSdk {
  if (injected) return injected;
  try {
    const loaded = createRequire(import.meta.url)("@unbrained/pm-cli/sdk") as TodoSourceSdk;
    if (typeof loaded.acquireLockLease !== "function") throw new Error();
    return loaded;
  }
  catch { throw new TodoSourceError("sdk_unavailable", "Install the supported pm CLI peer or inject its public SDK."); }
}
/** Reject prototypes, accessors and unknown keys before inspecting nested input. */
function object(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
  const keys = Reflect.ownKeys(value);
  if (keys.length > names.length || keys.some(key => typeof key !== "string" || !names.includes(key))) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(entry => !entry.enumerable || !Object.hasOwn(entry, "value"))) throw new Error();
  return value as Record<string, unknown>;
}
/** Arrays must be dense JSON arrays with no hidden or extra properties. */
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) throw new Error();
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i) || Object.getOwnPropertyDescriptor(value, String(i))?.enumerable !== true || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(i)) ?? {}, "value")) throw new Error();
  return value;
}
/** Only new manifest paths are portable relative names, never filesystem traversal. */
function fileName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 240 || !value || /[\\\u0000-\u001f:]/.test(value) || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error();
}
/** A bounded canonical tracker identity; lookups always use Map or Set. */
function identity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error();
}
/** Validate all transport input once, before SDK reads, locks, files or journals. */
function request(input: unknown): Request {
  try {
    const root = object(input, ["action", "selection", "manifest", "files"]);
    const ids = new Set<string>(), names = new Set<string>();
    if (root.action === "export") {
      object(root, ["action", "selection"]);
      const selection = object(root.selection, ["sources"]);
      for (const entry of array(selection.sources, 32)) {
        const source = object(entry, ["file", "ids"]); fileName(source.file);
        if (names.has(source.file)) throw new TodoSourceError("duplicate_ownership", "Select every file and row exactly once.");
        names.add(source.file);
        for (const id of array(source.ids, 1000)) {
          identity(id);
          if (ids.has(id)) throw new TodoSourceError("duplicate_ownership", "Select every row in exactly one source file.", id);
          ids.add(id);
        }
      }
    } else if (root.action === "apply") {
      object(root, ["action", "manifest", "files"]);
      const manifest = object(root.manifest, ["version", "sources", "session", "digest"]);
      if (manifest.version !== 1) throw new Error();
      for (const entry of array(manifest.sources, 32)) {
        const source = object(entry, ["file", "rows"]); fileName(source.file);
        if (names.has(source.file)) throw new TodoSourceError("duplicate_ownership", "Keep one manifest entry per source file.");
        names.add(source.file);
        for (const entry of array(source.rows, 1000)) {
          const row = object(entry, ["id", "revision", "owner"]); identity(row.id);
          if (typeof row.revision !== "string" || !/^[a-f0-9]{64}$/.test(row.revision)) throw new Error();
          if (row.owner !== null) fileName(row.owner);
          if (row.owner !== null && row.owner !== source.file) throw new TodoSourceError("foreign_owner", "Export from the current owning file before moving this row.", row.id);
          if (ids.has(row.id)) throw new TodoSourceError("duplicate_ownership", "Keep each identity in exactly one manifest source.", row.id);
          ids.add(row.id);
        }
      }
      const session = object(manifest.session, ["version", "digest", "entries"]);
      const baselineIds = new Set<string>();
      for (const value of array(session.entries, 1000)) {
        const entry = object(value, ["id", "line", "itemDigest", "fieldDigests"]); identity(entry.id);
        const digests = object(entry.fieldDigests, FIELD_NAMES);
        if (FIELD_NAMES.some(field => typeof digests[field] !== "string" || !/^[a-f0-9]{64}$/.test(digests[field] as string)) || typeof entry.line !== "string" || entry.line.length > 65536 || typeof entry.itemDigest !== "string") throw new Error();
        baselineIds.add(entry.id);
      }
      if (baselineIds.size !== ids.size || [...ids].some(id => !baselineIds.has(id))) throw new Error();
      const files = new Set<string>();
      let bytes = 0;
      for (const value of array(root.files, 32)) {
        const entry = object(value, ["file", "text"]); fileName(entry.file);
        if (!names.has(entry.file) || files.has(entry.file)) throw new TodoSourceError("source_scope", "Supply every manifest file exactly once; omit unrelated files.");
        files.add(entry.file);
        if (typeof entry.text !== "string" || entry.text.split(/\r?\n/).some(line => line.length > 65536)) throw new Error();
        if (/(?:^|\s)__proto__:\S+/.test(entry.text)) throw new TodoSourceError("session_refused", "Use another metadata key: the supported native history codec cannot round-trip __proto__ safely. Preserve existing tracker data.");
        bytes += Buffer.byteLength(entry.text);
      }
      if (bytes > MAX_BYTES || files.size !== names.size) throw new TodoSourceError("source_scope", "Supply exactly the selected files, with at most 4 MiB of text in total.");
      const typed = root.manifest as TodoSourceManifest;
      if (typed.digest !== hash({ version: typed.version, sources: typed.sources, session: typed.session })) throw new Error();
      // The existing producer/validator remains the authority for the embedded session.
      const baseline = typed.session.entries.map(row => `${row.line} pm-session:${row.id}\n`).join("");
      if (planTodoEditingSession(typed.session, baseline, []).result.refusals.some(refusal => refusal.code === "invalid_session")) throw new Error();
    } else throw new Error();
    if (!names.size || !ids.size || ids.size > 1000) throw new Error();
    return structuredClone(input) as Request;
  } catch (error) {
    if (error instanceof TodoSourceError) throw error;
    throw new TodoSourceError("invalid_input", "Use an unchanged version 1 manifest or an explicit selection: 1..32 distinct relative files, 1..1000 unique rows and dense JSON arrays.");
  }
}
/** Validate a manifest before a transport opens any of its named files. */
export function parseTodoSourceManifest(input: unknown): TodoSourceManifest {
  let files: TodoSourceFile[];
  try {
    const root = object(input, ["version", "sources", "session", "digest"]);
    files = array(root.sources, 32).map(value => {
      const source = object(value, ["file", "rows"]); fileName(source.file);
      return { file: source.file, text: "" };
    });
  } catch { throw new TodoSourceError("invalid_input", "Use the unchanged source manifest from export."); }
  const parsed = request({ action: "apply", manifest: input, files });
  if (parsed.action !== "apply") throw new Error("unreachable");
  return parsed.manifest;
}
/** Verify authoritative native documents and their complete immutable history, without cache trust. */
async function snapshot(core: TodoSourceSdk, pmRoot: string, settings: PmSettings, id: string, document?: ItemDocument): Promise<Snapshot> {
  try {
  if (!document) {
    const located = await core.locateItem(pmRoot, id, settings.id_prefix, settings.item_format, core.resolveItemTypeRegistry(settings).type_to_folder);
    if (!located) throw new TodoSourceError("stale_revision", "Restore the missing row or export a fresh selection.", id);
    document = (await core.readLocatedItem(located, { schema: settings.schema, extensionFieldNames: EXTENSIONS })).document;
  }
  const history = await core.readHistoryEntries(core.getHistoryPath(pmRoot, id), id);
  if (!history.length || !core.verifyHistoryEntries(history, document).ok) throw new TodoSourceError("invalid_history", "Inspect pm health and preserve the damaged history; export again only after integrity is restored.", id);
  return { document, history, revision: historyRevision(history) };
  } catch (error) {
    if (error instanceof TodoSourceError) throw error;
    throw new TodoSourceError("invalid_history", "Inspect this row and its native history with pm health; preserve the unreadable data before retrying.", id);
  }
}
/** Bind markers to the selected target revisions, never content alone. */
function marker(transaction: string, id: string, phase = "apply"): string { return `pm-todos-source-v1:${transaction}:${id}:${phase}`; }
/** Compare SDK-normalized values, projecting only ownership fields or the fields they must preserve. */
function recoveryValues(core: TodoSourceSdk, document: ItemDocument, settings: PmSettings, owned: boolean): string {
  const canonical = core.canonicalDocument(document, { schema: settings.schema, extensionFieldNames: EXTENSIONS });
  const metadata = Object.fromEntries(Object.entries(canonical.metadata).filter(([field]) => field !== "updated_at" && field !== "item_format_version" && WRITE_FIELDS.has(field) === owned));
  return core.stableUpsertValue(owned ? { metadata } : { metadata, body: canonical.body });
}
/** Refuse unproven ownership without echoing either native values or operator paths. */
function staleRevision(id: string): never {
  throw new TodoSourceError("stale_revision", "A selected row changed since export. Export all selected files again and review the edit before retrying.", id);
}
/** Recover the immutable exported document from verified native history, never from observed edited values. */
function revisionBaseline(core: TodoSourceSdk, current: Snapshot, row: TodoSourceRow, transaction: string): Snapshot {
  if (current.revision === row.revision) return current;
  const applied = marker(transaction, row.id), compensated = marker(transaction, row.id, "compensate");
  let start = current.history.length;
  while (start > 0 && [applied, compensated].includes(current.history[start - 1].message ?? "")) start--;
  if (!start || start === current.history.length || historyRevision(current.history.slice(0, start)) !== row.revision) return staleRevision(row.id);
  return { document: core.replayHistoryToTarget(current.history, start - 1) as ItemDocument, history: current.history.slice(0, start), revision: row.revision };
}
/** Recognize ownership only when every forward event equals the immutable producer-derived intent. */
function revisionState(core: TodoSourceSdk, current: Snapshot, row: TodoSourceRow, transaction: string, settings: PmSettings, intended: string): "pending" | "applied" | "compensated" {
  if (current.revision === row.revision) return "pending";
  const baseline = revisionBaseline(core, current, row, transaction);
  const originalValues = recoveryValues(core, baseline.document, settings, true);
  let document = baseline.document, phase: "pending" | "applied" | "compensated" = "pending";
  for (let index = baseline.history.length; index < current.history.length; index++) {
    const entry = current.history[index];
    const next = core.applyHistoryPatch(document, entry.patch, index + 1, entry.op) as ItemDocument;
    if (entry.op !== "update" || recoveryValues(core, document, settings, false) !== recoveryValues(core, next, settings, false)) return staleRevision(row.id);
    if (entry.message === marker(transaction, row.id)) {
      if (phase === "applied" || recoveryValues(core, next, settings, true) !== intended) return staleRevision(row.id);
      phase = "applied";
    } else {
      if (phase !== "applied" || recoveryValues(core, next, settings, true) !== originalValues) return staleRevision(row.id);
      phase = "compensated";
    }
    document = next;
  }
  return phase;
}
/** Materialize intent and native writes with one patch applicator; SDK canonicalization supplies comparisons. */
function applyValues(document: ItemDocument, values: TodoSessionPatch["values"]): string[] {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete document.metadata[key]; else document.metadata[key] = value;
  }
  return Object.keys(values);
}
/** Parse ownership using the same embedded editing-session planner as field edits. */
function proposals(manifest: TodoSourceManifest, files: TodoSourceFile[], current: Snapshot[], registry: RuntimeStatusRegistry): { patches: TodoSessionPatch[]; moved: number } {
  const planned = planTodoEditingSession(manifest.session, files.map(file => file.text).join("\n"), current.map(row => row.document.metadata as PmItem), registry);
  if (!planned.result.ok) {
    const first = planned.result.refusals[0];
    throw new TodoSourceError(first.code === "duplicate_id" ? "duplicate_ownership" : "session_refused", first.remedy, first.id);
  }
  if (planned.result.omitted) throw new TodoSourceError("missing_row", "Retain every selected identity in exactly one selected file; omissions never delete items.");
  const owners = new Map<string, string>();
  for (const file of files) for (const line of file.text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const id = line.trimEnd().slice(line.trimEnd().lastIndexOf("pm-session:") + 11);
    owners.set(id, file.file);
  }
  const patches = new Map(planned.patches.map(patch => [patch.id, patch]));
  let moved = 0;
  for (const row of current) {
    const id = row.document.metadata.id, owner = owners.get(id);
    if (row.document.metadata.todos_source_file === owner) continue;
    const patch = patches.get(id) ?? { id, values: {} };
    patch.values.todos_source_file = owner;
    patches.set(id, patch); moved++;
  }
  return { patches: [...patches.values()], moved };
}
/** Export exactly the authorized ids; unsupported rows fail individually with their identity. */
export async function exportTodoSourceSelection(pmRoot: string, input: unknown, options: { sdk?: TodoSourceSdk } = {}): Promise<TodoSourceExport> {
  const parsed = request({ action: "export", selection: input });
  if (parsed.action !== "export") throw new Error("unreachable");
  const core = sdk(options.sdk), settings = await core.readSettings(pmRoot);
  const snapshots = new Map<string, Snapshot>();
  const sources: TodoSourceManifest["sources"] = [];
  const files: TodoSourceFile[] = [];
  const registry = core.resolveRuntimeStatusRegistry(settings.schema);
  let skipped = 0;
  const refusals: TodoSourceRefusal[] = [];
  for (const source of parsed.selection.sources) {
    const rows: TodoSourceRow[] = [], texts: string[] = [];
    for (const id of source.ids) {
      try {
      const current = await snapshot(core, pmRoot, settings, id);
      if (current.document.metadata.id !== id) throw new TodoSourceError("invalid_input", "Select canonical complete item ids.");
      const owner = current.document.metadata.todos_source_file ?? null;
      if (owner !== null && owner !== source.file) throw new TodoSourceError("foreign_owner", "Select this row under its current owning file, then move its identified line.", id);
      let exported: ReturnType<typeof createTodoEditingSession>;
      try { exported = createTodoEditingSession([current.document.metadata as PmItem], registry); }
      catch { throw new TodoSourceError("session_refused", "This row cannot round-trip through todo.txt. Exclude it and use JSONL for that row.", id); }
      texts.push(exported.text); snapshots.set(id, current);
      rows.push({ id, revision: current.revision, owner: owner as string | null });
      } catch (error) {
        if (!(error instanceof TodoSourceError)) throw error;
        skipped++;
        if (refusals.length < 20) refusals.push({ code: error.code, remedy: error.remedy, id });
      }
    }
    sources.push({ file: source.file, rows }); files.push({ file: source.file, text: texts.join("") });
  }
  if (!snapshots.size) {
    const first = refusals[0];
    throw new TodoSourceError(first.code, first.remedy, first.id);
  }
  const session = createTodoEditingSession([...snapshots.values()].map(row => row.document.metadata as PmItem), registry).session;
  const base = { version: 1 as const, sources, session };
  const manifest = { ...base, digest: hash(base) };
  request({ action: "apply", manifest, files });
  return { manifest, files, skipped, refusals };
}
/** Validate numeric output as well as input; counts never depend on floating-point ratios. */
function receipt(result: TodoSourceResult): TodoSourceResult {
  for (const key of ["files", "selected", "changed", "applied", "moved", "unchanged"] as const) if (!Number.isSafeInteger(result[key]) || result[key] < 0 || result[key] > (key === "files" ? 32 : 1000)) throw new Error("Invalid selection receipt count");
  return result;
}
/** Apply controls include deterministic observers for crash and concurrent-writer acceptance. */
export interface TodoSourceApplyOptions {
  author: string;
  dryRun?: boolean;
  sdk?: TodoSourceSdk;
  commit?: (options: Omit<CommitWorkspaceTransactionOptions, "pmRoot">) => ReturnType<TodoSourceSdk["commitWorkspaceTransaction"]>;
  onTransition?: CommitWorkspaceTransactionOptions["onTransition"];
}
/** Replan previews, writes and recovery with one path; core journals compensate ordinary failures. */
export async function applyTodoSourceSelection(pmRoot: string, manifest: unknown, files: unknown, options: TodoSourceApplyOptions): Promise<TodoSourceResult> {
  let result: TodoSourceResult = { ok: false, files: 0, selected: 0, changed: 0, applied: 0, moved: 0, unchanged: 0, refusals: [] };
  try {
    const parsed = request({ action: "apply", manifest, files });
    if (parsed.action !== "apply") throw new Error("unreachable");
    if (typeof options.author !== "string" || !options.author.trim() || options.author.length > 160 || (options.dryRun !== undefined && typeof options.dryRun !== "boolean")) throw new TodoSourceError("invalid_input", "Supply a bounded nonempty author and an optional boolean dryRun.");
    const core = sdk(options.sdk), settings = await core.readSettings(pmRoot);
    const registry = core.resolveRuntimeStatusRegistry(settings.schema);
    parsed.files = parsed.files.map(file => ({ file: file.file, text: normalizeTodoEditingText(file.text) }));
    const rows = parsed.manifest.sources.flatMap(source => source.rows);
    const transaction = core.deriveMutationTransactionId(JSON.stringify(["pm-todos-source-v1", parsed.manifest.digest, [...parsed.files].sort((a,b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0).map(file => [file.file, file.text.split("\n").filter(Boolean).sort()])]));
    result = { ...result, files: parsed.files.length, selected: rows.length, transaction };
    const baselines = new Map<string, Snapshot>();
    for (const row of rows) baselines.set(row.id, revisionBaseline(core, await snapshot(core, pmRoot, settings, row.id), row, transaction));
    const intent = new Map(proposals(parsed.manifest, parsed.files, [...baselines.values()], registry).patches.map(patch => [patch.id, patch.values]));
    const intended = new Map([...baselines].map(([id, baseline]) => {
      const document = structuredClone(baseline.document);
      applyValues(document, intent.get(id) ?? {});
      return [id, recoveryValues(core, document, settings, true)];
    }));
    /** Every use still reads and verifies the current target, including while its native write lock is held. */
    const inspectRevision = (current: Snapshot, row: TodoSourceRow) => revisionState(core, current, row, transaction, settings, intended.get(row.id)!);
    /** Revalidate every target, including unchanged targets and previously completed steps. */
    let hasTransactionHistory = false;
    const readAll = async (): Promise<Snapshot[]> => {
      const current: Snapshot[] = [];
      for (const row of rows) {
        const value = await snapshot(core, pmRoot, settings, row.id);
        const phase = inspectRevision(value, row); current.push(value);
        if (phase !== "pending") hasTransactionHistory = true;
      }
      return current;
    };
    /** Same planner is called under the selection lease and each native mutation lock. */
    const plan = async () => proposals(parsed.manifest, parsed.files, await readAll(), registry);
    const initial = await plan();
    result = { ...result, ok: true, changed: initial.patches.length, moved: initial.moved, unchanged: rows.length - initial.patches.length };
    if (options.dryRun || (!initial.patches.length && !hasTransactionHistory)) return receipt(result);
    const lease = await core.acquireLockLease(pmRoot, "pm-todos-source-selection", 120, options.author, false, false, settings.locks.wait_ms);
    try {
      return await lease.fence(async () => {
        const locked = await plan();
        result = { ...result, changed: locked.patches.length, moved: locked.moved, unchanged: rows.length - locked.patches.length };
        if (!locked.patches.length && !hasTransactionHistory) return receipt(result);
        const steps: WorkspaceTransactionStep[] = rows.map(row => ({
          id: row.id,
          async inspect() {
            const current = await snapshot(core, pmRoot, settings, row.id);
            return { state: inspectRevision(current, row), result: row.id };
          },
          async prepareCompensation() {
            const current = await snapshot(core, pmRoot, settings, row.id);
            inspectRevision(current, row);
            return JSON.parse(JSON.stringify(current.document.metadata)) as WorkspaceTransactionJsonValue;
          },
          async apply() {
            await plan();
            const changed = await core.mutateItem({ pmRoot, settings, id: row.id, op: "update", author: options.author, message: marker(transaction, row.id), extensionFieldNames: EXTENSIONS, skipNoop: true,
              async mutate(document) {
                inspectRevision(await snapshot(core, pmRoot, settings, row.id, document), row);
                const all = await readAll();
                const index = rows.indexOf(row); all[index] = await snapshot(core, pmRoot, settings, row.id, document);
                const patch = proposals(parsed.manifest, parsed.files, all, registry).patches.find(patch => patch.id === row.id);
                return { changedFields: applyValues(document, patch?.values ?? {}) };
              },
            });
            if (changed.changedFields.length) result.applied++;
            return row.id;
          },
          async compensate(data) {
            const compensated = await core.mutateItem({ pmRoot, settings, id: row.id, op: "update", author: options.author, message: marker(transaction, row.id, "compensate"), extensionFieldNames: EXTENSIONS, skipNoop: true,
              async mutate(document) {
                const current = await snapshot(core, pmRoot, settings, row.id, document);
                try {
                  if (inspectRevision(current, row) !== "applied") return { changedFields: [] };
                } catch {
                  if (!current.history.some(entry => entry.message === marker(transaction, row.id))) return { changedFields: [] };
                  throw new TodoSourceError("superseded", "A peer changed an applied row. Preserve the journal and reconcile it; compensation will not overwrite the peer.", row.id);
                }
                if (data === null || typeof data !== "object" || Array.isArray(data)) throw new TodoSourceError("apply_failed", "Preserve and inspect the native transaction journal before retrying.", row.id);
                const baseline = baselines.get(row.id)!.document;
                const saved = { metadata: data as ItemDocument["metadata"], body: baseline.body };
                if (recoveryValues(core, saved, settings, true) !== recoveryValues(core, baseline, settings, true)) throw new TodoSourceError("apply_failed", "Compensation data does not match the exported native revision. Preserve and inspect the transaction journal.", row.id);
                return { changedFields: applyValues(document, Object.fromEntries([...WRITE_FIELDS].map(field => [field, baseline.metadata[field]]))) };
              },
            });
            if (compensated.changedFields.length) result.applied = Math.max(0, result.applied - 1);
          },
        }));
        const controls = { transactionId: transaction, author: options.author, steps, lockTtlSeconds: 120,
          async onTransition(context: Parameters<NonNullable<CommitWorkspaceTransactionOptions["onTransition"]>>[0]) {
            await options.onTransition?.(context);
            if (["prepared", "step_applied", "step_recorded", "committing"].includes(context.transition)) await plan();
          },
        };
        if (options.commit) await options.commit(controls);
        else await core.commitWorkspaceTransaction({ ...controls, pmRoot });
        if ((await plan()).patches.length) throw new TodoSourceError("apply_failed", "The native transaction did not complete every selected row. Preserve the journal and reconcile the remaining targets before retrying.");
        return receipt(result);
      });
    } finally { await lease.release(); }
  } catch (error) {
    const errors: unknown[] = [error];
    let refusal: TodoSourceError | undefined;
    const visited = new Set<unknown>();
    for (const value of errors) {
      if (visited.has(value)) continue; visited.add(value);
      if (value instanceof TodoSourceError && (!refusal || refusal.code !== "superseded")) refusal = value;
      if (value instanceof Error) errors.push(value.cause);
      if (value instanceof AggregateError) errors.push(...value.errors);
    }
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const reason = refusal ?? (code === "lock_conflict" || code === "lock_lost"
      ? new TodoSourceError("busy", "A peer owns the selection or an item lease. Retain the same input, wait for the peer and preview again.")
      : new TodoSourceError("apply_failed", "Preserve the native transaction journal and preview the same input before recovery; export fresh only after reconciling stale targets."));
    return receipt({ ...result, ok: false, refusals: [{ code: reason.code, remedy: reason.remedy, ...(reason.id ? { id: reason.id } : {}) }] });
  }
}
