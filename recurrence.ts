/** Explicit todo.txt recurrence adaptation; core owns storage, locks and lifecycle. */
import { createHash } from "node:crypto";
import {
  create, getHistoryPath, locateItem, mutateItem, normalizeItemId, readHistoryEntries,
  readLocatedItem, readSettings, resolveRuntimeStatusRegistry, verifyHistoryEntries,
  type ItemDocument, type PmSettings, type RuntimeStatusRegistry,
} from "@unbrained/pm-cli/sdk";
import { parseTodoTxtLine, serializeTodoTxtLine, type PmItem } from "./index.ts";

/** One bounded operation; omitting dialect disables interpretation and all writes. */
export interface TodoRecurrenceRequest {
  id: string;
  dialect?: "todotxt-weekly-v1";
  timezone?: "floating";
  expectedRevision?: string;
}
/** Stable policy errors carry recovery guidance without source text. */
export type TodoRecurrenceCode = "invalid_input" | "unsupported_timezone" | "missing_item" | "invalid_history" | "not_done" | "invalid_source" | "unsupported_recurrence" | "invalid_date" | "source_conflict" | "foreign_target" | "write_failed";
/** A single preview/apply receipt stays constant-sized for agent transports. */
export interface TodoRecurrenceResult {
  ok: boolean;
  action: "disabled" | "preview" | "created" | "unchanged" | "skipped";
  created: 0 | 1;
  policy: "floating-date; weekly; explicit-only";
  revision?: string;
  series?: string;
  occurrence?: string;
  nextId?: string;
  originalDue?: string;
  anchor?: string;
  nextDue?: string;
  code?: TodoRecurrenceCode;
  remedy?: string;
}
/** Awaited observations support deterministic interleaving and crash recovery tests. */
export type TodoRecurrenceTransition = "before_lock" | "source_locked" | "before_target_read" | "before_create" | "after_create" | "before_release";
/** Hooks observe transitions while the source lease is retained through publication. */
export interface TodoRecurrenceApplyOptions {
  author: string;
  onTransition?: (transition: TodoRecurrenceTransition) => Promise<void>;
}
const POLICY = "floating-date; weekly; explicit-only" as const;
const MESSAGE = "pm-todos recurring occurrence v1";
const KEYS = ["pmseries", "pmoccurrence", "pmoriginaldue", "pmprevious", "pmrevision"] as const;

/** Construct refusals centrally: no partial success, nonfinite counts or source payload. */
function refuse(code: TodoRecurrenceCode, remedy: string): TodoRecurrenceResult {
  return { ok: false, action: "skipped", created: 0, policy: POLICY, code, remedy };
}
/** Validate the sole untrusted input schema once, before any SDK I/O. */
function request(value: unknown): TodoRecurrenceRequest | TodoRecurrenceResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse("invalid_input", "Pass an object with id, optional dialect, timezone and expectedRevision.");
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return refuse("invalid_input", "Pass a plain JSON object, without inherited fields or accessors.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(field => !Object.hasOwn(field, "value"))) return refuse("invalid_input", "Pass JSON values, without accessors.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["id", "dialect", "timezone", "expectedRevision"].includes(key)) || typeof row.id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(row.id) || (row.dialect !== undefined && row.dialect !== "todotxt-weekly-v1") || (row.expectedRevision !== undefined && (typeof row.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(row.expectedRevision)))) return refuse("invalid_input", "Use a bounded pm id, dialect todotxt-weekly-v1 and the 64-digit revision returned by preview; omit unknown fields.");
  if (row.timezone !== undefined && row.timezone !== "floating") return refuse("unsupported_timezone", "Use timezone floating. This dialect accepts date-only calendars, never timestamps, UTC offsets or IANA zones; no DST conversion occurs.");
  return row as unknown as TodoRecurrenceRequest;
}
/** Accept real four-digit Gregorian calendar dates without JavaScript rollover. */
function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01" || value > "9999-12-31") return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
/** Hash identity tuples; source revisions guard attempts, never multiply occurrences. */
function hash(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
/** Read authoritative item documents through the SDK, bypassing list projections. */
async function read(pmRoot: string, id: string, settings: PmSettings): Promise<ItemDocument | undefined> {
  const item = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format);
  return item ? (await readLocatedItem(item, { schema: settings.schema, extensionFieldNames: ["todos_kv", "todos_todotxt", "todos_completion_date", "todos_creation_date"] })).document : undefined;
}
/** Bind a preview to its immutable history tip, including replayed content revisions. */
async function revision(pmRoot: string, document: ItemDocument): Promise<string | undefined> {
  const history = await readHistoryEntries(getHistoryPath(pmRoot, document.metadata.id), document.metadata.id);
  if (!history.length || !verifyHistoryEntries(history, document).ok) return undefined;
  return history.at(-1)?.record_hash ?? hash(["todos-legacy-revision-v1", JSON.stringify(history)]);
}
/** Validate provenance and recognize only occurrences this package actually created. */
async function owned(pmRoot: string, document: ItemDocument, kv: Record<string, string>): Promise<boolean> {
  const actual = document.metadata.todos_kv as Record<string, string> | undefined;
  const history = await readHistoryEntries(getHistoryPath(pmRoot, document.metadata.id), document.metadata.id);
  return Boolean(actual && KEYS.every(key => actual[key] === kv[key]) && history[0]?.op === "create" && history[0]?.message === MESSAGE && verifyHistoryEntries(history, document).ok);
}
/** Internal preview includes validated native creation fields; callers only receive receipts. */
interface Proposal { receipt: TodoRecurrenceResult; kv: Record<string, string>; item: PmItem; line: string }
/** Derive one next date from the current locked source, retaining the exact source due. */
async function propose(pmRoot: string, input: TodoRecurrenceRequest, document: ItemDocument, settings: PmSettings, registry: RuntimeStatusRegistry): Promise<Proposal | TodoRecurrenceResult> {
  const tip = await revision(pmRoot, document);
  if (!tip) return refuse("invalid_history", "Inspect pm health and preserve history; obtain a valid SDK history chain before previewing again.");
  if (input.expectedRevision !== undefined && input.expectedRevision !== tip) return refuse("source_conflict", "The source revision changed. Read the current item and preview again; never replay a saved plan.");
  const item = document.metadata as unknown as PmItem;
  if (!registry.terminal_done_statuses.has(item.status) || registry.terminal_canceled_statuses.has(item.status)) return refuse("not_done", "Complete the source through the configured done lifecycle; active, blocked and canceled items do not recur.");
  if (typeof item.todos_todotxt !== "string" || item.todos_todotxt.length > 16384 || /[\r\n]/.test(item.todos_todotxt)) return refuse("invalid_source", "Import one bounded todo.txt line with fidelity mapping; source text is required and stays unchanged.");
  const parsed = parseTodoTxtLine(item.todos_todotxt);
  const kv = item.todos_kv;
  if (!parsed || !kv || typeof kv.rec !== "string" || parsed.kv?.rec !== kv.rec || parsed.due === undefined) return refuse("invalid_source", "Reconcile the fidelity source rec and due tokens with current SDK fields, then preview again.");
  if (!date(parsed.due)) return refuse("invalid_date", "Use a real YYYY-MM-DD source due date in years 0001–9999; rollover and timestamps are refused.");
  if (item.deadline !== parsed.due && item.deadline !== parsed.due + "T00:00:00.000Z") return refuse("invalid_source", "Reconcile the source due token with the current SDK deadline; no truncation or implicit rescheduling is allowed.");
  // Duplicate tokens would make a last-wins parser silently choose a policy.
  for (const key of ["rec", "due"]) if (parsed.bodyTokens.filter(token => token.startsWith(key + ":")).length !== 1) return refuse("invalid_source", "Keep exactly one rec token and one due token; resolve duplicates explicitly.");
  const rule = /^(\+?)([1-9]|[1-4][0-9]|5[0-2])w$/.exec(kv.rec);
  if (!rule) return refuse("unsupported_recurrence", "Use rec:1w through rec:52w (completion anchored), or rec:+1w through rec:+52w (due anchored).");
  const anchor = rule[1] === "+" ? parsed.due : item.todos_completion_date;
  if (!date(parsed.due) || !date(anchor)) return refuse("invalid_date", "Use real YYYY-MM-DD dates in years 0001–9999; completion-anchored recurrence also needs todos_completion_date. No rollover or timestamp truncation is allowed.");
  const next = new Date(anchor + "T00:00:00.000Z");
  next.setUTCDate(next.getUTCDate() + Number(rule[2]) * 7);
  const nextDue = next.toISOString().slice(0, 10);
  if (!date(nextDue)) return refuse("invalid_date", "The next date exceeds the supported calendar (0001–9999); shorten the interval or stop this series.");
  if (Object.entries(kv).length > 100 || Object.entries(kv).some(([key, value]) => !/^[^\s:]{1,80}$/.test(key) || typeof value !== "string" || !/^[^\s:]{1,1000}$/.test(value)) || typeof item.title !== "string" || item.title.length > 4096 || (item.priority !== undefined && (!Number.isInteger(item.priority) || item.priority < 0 || item.priority > 4)) || (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 100 || Array.from(item.tags).some(tag => typeof tag !== "string" || tag.length > 128)))) return refuse("invalid_source", "Use at most 100 bounded todo.txt tokens/tags, a bounded title and priority 0–4; unsupported metadata must be reconciled before recurrence.");
  const inherited = KEYS.some(key => kv[key] !== undefined);
  if (inherited && (!/^[a-f0-9]{64}$/.test(kv.pmseries) || !/^[a-f0-9]{64}$/.test(kv.pmoccurrence) || !/^[a-f0-9]{64}$/.test(kv.pmrevision) || !date(kv.pmoriginaldue) || !/^[a-zA-Z0-9_-]{1,160}$/.test(kv.pmprevious))) return refuse("foreign_target", "Preserve externally supplied occurrence metadata; select an original source with no reserved pmseries/pmoccurrence keys.");
  if (inherited && !await owned(pmRoot, document, kv)) return refuse("foreign_target", "This imported or externally created occurrence has no package creation receipt; select the original source or start an explicitly reviewed new series.");
  const series = inherited ? kv.pmseries : hash(["todos-series-v1", item.id]);
  const occurrence = hash(["todos-occurrence-v1", item.id]);
  const nextId = normalizeItemId("occ-" + occurrence.slice(0, 32), settings.id_prefix);
  const nextKv = { ...kv, pmseries: series, pmoccurrence: occurrence, pmoriginaldue: parsed.due, pmprevious: item.id, pmrevision: tip };
  const nextItem: PmItem = { id: nextId, title: item.title, type: "Task", status: registry.open_status, priority: item.priority, tags: item.tags, deadline: nextDue, todos_kv: nextKv, todos_todotxt: item.todos_todotxt };
  const line = serializeTodoTxtLine(nextItem, "fidelity", registry);
  if (Object.keys(nextKv).length > 100 || parseTodoTxtLine(line)?.text !== item.title || line.length > 16384 || /[\r\n]/.test(line)) return refuse("invalid_source", "Use a title representable in todo.txt, at most 100 metadata entries including provenance, and a 16384-character single-line source.");
  return { receipt: { ok: true, action: "preview", created: 0, policy: POLICY, revision: tip, series, occurrence, nextId, originalDue: parsed.due, anchor, nextDue }, kv: nextKv, item: nextItem, line };
}
/** Compare live targets; a previous receipt alone can never establish unchanged state. */
async function existing(pmRoot: string, proposal: Proposal, settings: PmSettings): Promise<TodoRecurrenceResult | undefined> {
  const document = await read(pmRoot, proposal.item.id, settings);
  if (!document) return undefined;
  // Later source comments must not turn the same owned occurrence into a duplicate.
  const kv = { ...proposal.kv, pmrevision: (document.metadata.todos_kv as Record<string, string> | undefined)?.pmrevision ?? "" };
  if (!await owned(pmRoot, document, kv)) return refuse("foreign_target", "The stable next id is occupied by a foreign or invalid record. Preserve it and inspect ownership; no fields were overwritten.");
  return { ...proposal.receipt, action: "unchanged" };
}
/** Preview the next weekly occurrence; omitted dialect performs no reads or writes. */
export async function previewTodoOccurrence(pmRoot: string, value: unknown): Promise<TodoRecurrenceResult> {
  return execute(pmRoot, value);
}
/** Revalidate a preview revision under the SDK source lock before atomic creation. */
export async function applyTodoOccurrence(pmRoot: string, value: unknown, options: TodoRecurrenceApplyOptions): Promise<TodoRecurrenceResult> {
  return execute(pmRoot, value, options);
}
/** Share validation, derivation and live-state retries across CLI and SDK entry points. */
async function execute(pmRoot: string, value: unknown, options?: TodoRecurrenceApplyOptions): Promise<TodoRecurrenceResult> {
  let input: TodoRecurrenceRequest | TodoRecurrenceResult;
  try { input = request(value); }
  catch { return refuse("invalid_input", "Pass a plain JSON object without throwing accessors or proxy traps."); }
  if ("ok" in input) return input;
  if (!input.dialect) return { ok: true, action: "disabled", created: 0, policy: POLICY };
  if (options && (!input.expectedRevision || typeof options.author !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(options.author))) return refuse("invalid_input", "Apply needs a preview expectedRevision and a bounded author id.");
  try {
    const settings = await readSettings(pmRoot);
    const registry = resolveRuntimeStatusRegistry(settings.schema);
    const id = normalizeItemId(input.id, settings.id_prefix);
    const source = await read(pmRoot, id, settings);
    if (!source) return refuse("missing_item", "Select an existing source item in this tracker.");
    if (!options) {
      const proposal = await propose(pmRoot, input, source, settings, registry);
      return "receipt" in proposal ? await existing(pmRoot, proposal, settings) ?? proposal.receipt : proposal;
    }
    let result = refuse("write_failed", "Inspect tracker health and ownership, then preview current state before retrying.");
    await options.onTransition?.("before_lock");
    await mutateItem({ pmRoot, settings, id, op: "update", author: options.author, skipNoop: true,
      async mutate(document) {
        try {
          await options.onTransition?.("source_locked");
          const proposal = await propose(pmRoot, input, document, settings, resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema));
          if (!("receipt" in proposal)) { result = proposal; return { changedFields: [] }; }
          await options.onTransition?.("before_target_read");
          result = await existing(pmRoot, proposal, settings) ?? proposal.receipt;
          if (result.action !== "preview") return { changedFields: [] };
          await options.onTransition?.("before_create");
          try {
            const created = await create({ allowDuplicate: true, id: proposal.item.id, type: "Task", title: proposal.item.title, status: proposal.item.status, priority: proposal.item.priority, tags: proposal.item.tags?.join(","), deadline: proposal.receipt.nextDue, author: options.author, message: MESSAGE, field: ["todos_kv=" + JSON.stringify(proposal.kv), "todos_todotxt=" + proposal.line] }, { pmRoot });
            if (created.item.id !== proposal.item.id) throw new Error("Unexpected SDK identity");
            result = { ...proposal.receipt, action: "created", created: 1 };
          } catch {
            // A competing create is success only after checking its live provenance.
            result = await existing(pmRoot, proposal, settings) ?? refuse("write_failed", "Ensure pm-todos is active and creation governance permits a Task; inspect health, then preview again.");
          }
          await options.onTransition?.("after_create");
          return { changedFields: [] };
        } finally { await options.onTransition?.("before_release"); }
      },
    });
    return result;
  } catch { return refuse("write_failed", "Inspect tracker history, claims and locks; enable pm-todos, then preview current state before retrying. An interrupted creation is recognized from its live SDK receipt."); }
}
