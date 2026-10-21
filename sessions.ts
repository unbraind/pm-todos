/** Conflict-aware todo.txt sessions, independent of git and table importers. */
import { createHash } from "node:crypto";
import { listAllComplete, mutateItem, readSettings } from "@unbrained/pm-cli/sdk";
import { parseTodoTxtLine, serializeTodoTxtLine, todoTxtItemToPm, type PmItem } from "./index.ts";

/** Fields represented by an editable todo.txt line. */
const FIELDS = ["title", "priority", "tags", "deadline", "todos_creation_date", "todos_completion_date", "todos_kv"] as const;
/** A field name that a session can update without changing lifecycle state. */
export type TodoSessionField = typeof FIELDS[number] | "todos_todotxt" | "status";
/** A versioned baseline for one stable tracker identity. */
export interface TodoSessionEntry {
  id: string;
  line: string;
  itemDigest: string;
  fieldDigests: Record<TodoSessionField, string>;
}
/** Persist this sidecar unchanged while editing its accompanying text. */
export interface TodoEditingSession { version: 1; digest: string; entries: TodoSessionEntry[] }
/** Compact, typed refusal; text and tracker values are deliberately omitted. */
export interface TodoSessionRefusal {
  code: "invalid_session" | "invalid_line" | "unknown_id" | "duplicate_id" | "missing_item" | "field_conflict" | "lifecycle_required" | "write_failed";
  remedy: string;
  id?: string;
  field?: TodoSessionField;
  line?: number;
}
/** Preview/apply receipt, bounded independently of the tracker size. */
export interface TodoSessionResult {
  ok: boolean;
  changed: number;
  applied: number;
  unchanged: number;
  omitted: number;
  refusalCount: number;
  refusals: TodoSessionRefusal[];
  hasMore: boolean;
}
/** Internal field patch, containing only values changed by the external editor. */
interface SessionPatch { id: string; values: Record<string, unknown> }
/** Compute a canonical digest without depending on object insertion order. */
function digest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)]));
    return input ?? null;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
/** Compare the effective state, while retaining exact underlying field digests. */
function projected(line: string): Record<string, unknown> {
  const parsed = parseTodoTxtLine(line);
  if (!parsed || !parsed.text || [parsed.due, parsed.creationDate, parsed.completionDate].some(date => date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date))) throw new Error("invalid todo.txt line");
  const item = todoTxtItemToPm(parsed, "", "fidelity");
  return { title: item.title, priority: item.priority, tags: [...new Set((item.tags ?? []).map(tag => tag.toLowerCase()))].sort(), deadline: item.deadline, todos_creation_date: item.creationDate, todos_completion_date: item.completionDate, todos_kv: item.kv, status: parsed.done };
}
/** Build stable digests of the tracker fields, including source provenance. */
function fieldDigests(item: PmItem): Record<TodoSessionField, string> {
  return Object.fromEntries([...FIELDS, "todos_todotxt", "status"].map(field => [field, digest(item[field as keyof PmItem])])) as Record<TodoSessionField, string>;
}
/** Export stable ids and digests using the existing fidelity serializer. */
export function createTodoEditingSession(items: readonly PmItem[]): { session: TodoEditingSession; text: string } {
  const entries = [...items].sort((a, b) => a.id.localeCompare(b.id)).map(item => {
    if (!/^[a-zA-Z0-9_-]+$/.test(item.id)) throw new TypeError("Session requires stable pm item ids.");
    const line = serializeTodoTxtLine(item, "fidelity");
    if (/[\r\n]/.test(line) || /(?:^|\s)pm-session:/.test(line)) throw new TypeError("Session cannot represent multiline text or a reserved pm-session token; use JSONL export.");
    projected(line);
    const fields = fieldDigests(item);
    return { id: item.id, line, itemDigest: digest([item.id, fields]), fieldDigests: fields };
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new TypeError("Session requires unique pm item ids.");
  return { session: { version: 1, digest: digest(entries), entries }, text: entries.map(entry => `${entry.line} pm-session:${entry.id}\n`).join("") };
}
/** Verify untrusted sidecars before looking up or mutating tracker identities. */
function validSession(value: unknown): value is TodoEditingSession {
  try {
    const session = value as TodoEditingSession;
    return session.version === 1 && Array.isArray(session.entries) && new Set(session.entries.map(entry => entry.id)).size === session.entries.length && session.entries.every(entry => /^[a-zA-Z0-9_-]+$/.test(entry.id) && typeof entry.line === "string" && projected(entry.line) && [...FIELDS, "todos_todotxt", "status"].every(field => /^[a-f0-9]{64}$/.test(entry.fieldDigests[field as TodoSessionField])) && entry.itemDigest === digest([entry.id, entry.fieldDigests])) && session.digest === digest(session.entries);
  } catch { return false; }
}
/** Reconcile every line before writing; omitted baseline rows are retained. */
function plan(session: unknown, text: string, items: readonly PmItem[]): { result: TodoSessionResult; patches: SessionPatch[] } {
  const refusals: TodoSessionRefusal[] = [];
  let refusalCount = 0;
  /** Keep agent output bounded even for malformed large documents. */
  const refuse = (refusal: TodoSessionRefusal): void => { refusalCount++; if (refusals.length < 20) refusals.push(refusal); };
  const patches: SessionPatch[] = [];
  let unchanged = 0;
  const seen = new Set<string>();
  if (!validSession(session)) refuse({ code: "invalid_session", remedy: "Export a new session; keep the sidecar unchanged." });
  else {
    const baselines = new Map(session.entries.map(entry => [entry.id, entry]));
    const current = new Map(items.map(item => [item.id, item]));
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      if (!raw.trim()) continue;
      const match = /^(.*?)\s+pm-session:([a-zA-Z0-9_-]+)\s*$/.exec(raw);
      if (!match || /(?:^|\s)pm-session:/.test(match[1])) { refuse({ code: "invalid_line", line: index + 1, remedy: "Retain exactly one trailing pm-session identity per line; create new items with pm create." }); continue; }
      const [, line, id] = match;
      if (seen.has(id)) { refuse({ code: "duplicate_id", id, remedy: "Keep one line for this identity." }); continue; }
      seen.add(id);
      const baseline = baselines.get(id);
      const item = current.get(id);
      if (!baseline) { refuse({ code: "unknown_id", id, remedy: "Export a new session including this item." }); continue; }
      if (!item) { refuse({ code: "missing_item", id, remedy: "Inspect the missing item and export a new session." }); continue; }
      try {
        const before = projected(baseline.line), after = projected(line);
        const values: Record<string, unknown> = {};
        for (const field of FIELDS) {
          if (digest(before[field]) === digest(after[field])) continue;
          const currentValue = item[field];
          if (digest(currentValue) !== baseline.fieldDigests[field] && digest(currentValue) !== digest(after[field])) refuse({ code: "field_conflict", id, field, remedy: "Review the current tracker value and export a new session before retrying." });
          else if (digest(currentValue) !== digest(after[field])) values[field] = after[field];
        }
        if (before.status !== after.status) refuse({ code: "lifecycle_required", id, field: "status", remedy: "Use pm close or pm reopen with its required reason, then export a new session." });
        if (line.trim() !== baseline.line.trim() && item.todos_todotxt !== line.trim()) {
          if (digest(item.todos_todotxt) !== baseline.fieldDigests.todos_todotxt) refuse({ code: "field_conflict", id, field: "todos_todotxt", remedy: "Source token order changed concurrently; export a new session." });
          else values.todos_todotxt = line.trim();
        }
        if (Object.keys(values).length) patches.push({ id, values }); else unchanged++;
      } catch { refuse({ code: "invalid_line", id, line: index + 1, remedy: "Use a nonempty task title and valid ISO calendar dates." }); }
    }
  }
  return { result: { ok: refusalCount === 0, changed: patches.length, applied: 0, unchanged, omitted: validSession(session) ? session.entries.filter(entry => !seen.has(entry.id)).length : 0, refusalCount, refusals, hasMore: refusalCount > refusals.length }, patches };
}
/** Pure three-way preview; does not mutate its inputs or invoke git. */
export function reconcileTodoEditingSession(session: unknown, text: string, current: readonly PmItem[]): TodoSessionResult {
  return plan(session, text, current).result;
}
/** Read a certified complete tracker snapshot using the public SDK. */
export async function exportTodoEditingSession(pmRoot: string): Promise<ReturnType<typeof createTodoEditingSession>> {
  const result = await listAllComplete({}, { pmRoot });
  return createTodoEditingSession(result.items as PmItem[]);
}
/** Apply per-item changes under core item locks, with append-only history. */
export async function applyTodoEditingSession(pmRoot: string, session: unknown, text: string, options: { author: string; dryRun?: boolean }): Promise<TodoSessionResult> {
  const current = await listAllComplete({}, { pmRoot });
  const preview = plan(session, text, current.items as PmItem[]);
  if (!preview.result.ok || options.dryRun || !preview.patches.length) return preview.result;
  const settings = await readSettings(pmRoot);
  const baselines = new Map((session as TodoEditingSession).entries.map(entry => [entry.id, entry]));
  for (const patch of preview.patches) {
    try {
      await mutateItem({ pmRoot, settings, id: patch.id, op: "update", author: options.author, skipNoop: true, message: "Reconcile todo.txt editing session", extensionFieldNames: ["todos_todotxt", "todos_kv", "todos_creation_date", "todos_completion_date"], mutate(document) {
        // Compare against the original baseline while holding the same item lock
        // used by ordinary core writers. Independent fields survive this merge.
        const row = baselines.get(patch.id);
        const locked = plan(row ? { version: 1, entries: [row], digest: digest([row]) } : null, text.split(/\r?\n/).filter(line => line.trim().endsWith(`pm-session:${patch.id}`)).join("\n"), [document.metadata as PmItem]);
        if (!locked.result.ok) throw Object.assign(new Error("Session conflict"), { refusals: locked.result.refusals });
        const values = locked.patches[0]?.values ?? {};
        for (const [field, value] of Object.entries(values)) {
          if (value === undefined) delete document.metadata[field]; else document.metadata[field] = value;
        }
        return { changedFields: Object.keys(values) };
      } });
      preview.result.applied++;
    } catch (error) {
      const known = error instanceof Error && "refusals" in error ? error.refusals as TodoSessionRefusal[] : [{ code: "write_failed" as const, id: patch.id, remedy: "Inspect pm ownership, workflow and health; preserve this receipt and preview again before retrying." }];
      return { ...preview.result, ok: false, refusalCount: known.length, refusals: known, hasMore: false };
    }
  }
  return preview.result;
}
