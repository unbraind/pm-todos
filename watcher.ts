/** Bounded, durable proposals for one explicitly authorized session todo.txt file. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, readdir } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLock, listAllComplete, writeFileAtomic, serializeNdjsonRows, suppressHostOutput, EXIT_CODE } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { planTodoEditingSession, type TodoSessionResult, type TodoSessionPatch, type TodoSessionField } from "./sessions.ts";
import type { PmItem } from "./index.ts";

/** Limits apply before parsing, planning or adding durable queue entries. */
export interface TodoWatcherOptions {
  pmRoot: string;
  file: string;
  sessionFile: string;
  spool: string;
  stableMs?: number;
  pollMs?: number;
  maxBytes?: number;
  maxChanges?: number;
  maxPending?: number;
}
/** Clock and timer share a monotonic timeline; timers may resume before their requested delay. */
export interface TodoWatcherClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
/** Production timing stays monotonic even when the wall clock changes. */
const systemClock: TodoWatcherClock = { now: () => performance.now(), sleep: ms => delay(ms) };
/** JSON-safe field patch: values set fields, and removedFields explicitly deletes them. */
export interface TodoProposalPatch {
  id: string;
  values: Record<string, unknown>;
  removedFields: TodoSessionField[];
}
/** A proposal is review evidence, never an instruction to mutate a tracker. */
export interface TodoChangeProposal {
  version: 2;
  id: string;
  sourceRevision: string;
  sessionRevision: string;
  trackerRevision: string;
  text: string;
  result: TodoSessionResult;
  patches: TodoProposalPatch[];
}
/** Failures contain no source text or local paths and always name a remedy. */
export interface TodoWatcherRefusal {
  code: "still_waiting" | "invalid_options" | "source_unavailable" | "source_too_large" | "source_unstable" | "incomplete_write" | "session_unavailable" | "tracker_unavailable" | "plan_refused" | "change_limit" | "queue_full" | "spool_unavailable" | "spool_mismatch";
  remedy: string;
}
/** Counts-first response; the durable proposal carries the bounded review payload. */
export interface TodoWatcherReceipt {
  ok: boolean;
  state: "waiting" | "queued" | "duplicate" | "refused";
  pending?: number;
  proposalId?: string;
  changed?: number;
  omitted?: number;
  refusal?: TodoWatcherRefusal;
  result?: TodoSessionResult;
}
/** Persisted queue binding prevents accidental sharing across source/session/tracker tuples. */
interface Queue { version: 2; binding: string; proposals: TodoChangeProposal[] }
/** Preserve undefined planner values as explicit removals before JSON serialization. */
function persistablePatches(patches: readonly TodoSessionPatch[]): TodoProposalPatch[] {
  return patches.map(patch => ({
    id: patch.id,
    values: Object.fromEntries(Object.entries(patch.values).filter(([, value]) => value !== undefined)),
    removedFields: Object.entries(patch.values).filter(([, value]) => value === undefined).map(([field]) => field as TodoSessionField),
  }));
}
/** Resolve defaults once and prevent callers from disabling the hard resource ceilings. */
function options(value: TodoWatcherOptions): Required<TodoWatcherOptions> {
  const result = { stableMs: 500, pollMs: 100, maxBytes: 1_048_576, maxChanges: 100, maxPending: 20, ...value };
  for (const [key, max] of [["stableMs", 60_000], ["pollMs", 60_000], ["maxBytes", 4_194_304], ["maxChanges", 1000], ["maxPending", 100]] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > max) throw new TypeError("invalid_options");
  }
  for (const key of ["pmRoot", "file", "sessionFile", "spool"] as const) {
    if (typeof result[key] !== "string" || !result[key].trim()) throw new TypeError("invalid_options");
    result[key] = resolve(result[key]);
  }
  const spoolRelative = relative(result.pmRoot, result.spool);
  if (new Set([result.file, result.sessionFile, result.spool, result.pmRoot]).size !== 4 || (!(spoolRelative === ".." || spoolRelative.startsWith(`..${sep}`)) && !isAbsolute(spoolRelative)) || [result.file, result.sessionFile].includes(join(result.spool, "proposals.json"))) throw new TypeError("invalid_options");
  return result;
}
/** Canonical revision hashes are insensitive to object key and tracker row ordering. */
function hash(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input !== null && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)])) : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
/** Construct the shared compact refusal envelope. */
function refusal(code: TodoWatcherRefusal["code"], remedy: string): TodoWatcherReceipt {
  return { ok: false, state: "refused", refusal: { code, remedy } };
}
/** Read one regular file through a non-following descriptor with strict byte and identity checks. */
async function boundedRead(file: string, limit: number): Promise<string> {
  const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await descriptor.stat();
    if (!before.isFile()) throw new Error("source_unavailable");
    if (before.size > limit) throw new Error("source_too_large");
    const buffer = Buffer.alloc(Math.min(before.size + 1, limit + 1));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await descriptor.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > limit) throw new Error("source_too_large");
    const after = await descriptor.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || used !== after.size) throw new Error("source_unstable");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used));
  } finally { await descriptor.close(); }
}
/** Polling does not discover directories or subscribe to unrelated filesystem events. */
export class TodoSourceWatcher {
  private config: Required<TodoWatcherOptions> | undefined;
  private candidate: { revision: string; since: number } | undefined;
  private busy = false;
  private clock: TodoWatcherClock;
  /** Invalid configuration is returned as a typed refusal by poll, without I/O. */
  constructor(value: TodoWatcherOptions, clock: TodoWatcherClock = systemClock) {
    this.clock = clock;
    try { this.config = options(value); } catch { /* poll returns the public refusal. */ }
  }
  /** Sample once; proposals survive signals because persistence precedes the receipt. */
  async poll(): Promise<TodoWatcherReceipt> {
    const config = this.config;
    if (!config) return refusal("invalid_options", "Use distinct source, sidecar, spool and tracker paths; select positive limits within the documented ceilings.");
    if (this.busy) return refusal("source_unstable", "Wait for the current poll to finish before sampling again.");
    this.busy = true;
    try { return await this.sample(config); }
    finally { this.busy = false; }
  }
  /** Revalidate a stable snapshot before committing under the SDK queue lock. */
  private async sample(config: Required<TodoWatcherOptions>): Promise<TodoWatcherReceipt> {
    let text: string;
    try { text = await boundedRead(config.file, config.maxBytes); }
    catch (error) {
      this.candidate = undefined;
      const code = error instanceof Error && ["source_too_large", "source_unstable"].includes(error.message) ? error.message as "source_too_large" | "source_unstable" : "source_unavailable";
      return refusal(code, "Restore one regular UTF-8 source file within maxBytes; symlinks are not accepted, then retry after the writer finishes.");
    }
    const sourceRevision = hash(text);
    if (!this.candidate || this.candidate.revision !== sourceRevision) { this.candidate = { revision: sourceRevision, since: this.clock.now() }; return { ok: true, state: "waiting" }; }
    if (this.clock.now() - this.candidate.since < config.stableMs) return { ok: true, state: "waiting" };
    if (!text.endsWith("\n") && text.length > 0) return refusal("incomplete_write", "Finish the newline-terminated session write; omitted rows are always retained, never deleted.");
    let session: unknown;
    try { session = JSON.parse(await boundedRead(config.sessionFile, config.maxBytes * 8)); }
    catch { return refusal("session_unavailable", "Restore the original baseline JSON sidecar, or export a fresh session to new files."); }
    let items: PmItem[];
    try { items = (await listAllComplete({}, { pmRoot: config.pmRoot })).items as PmItem[]; }
    catch { return refusal("tracker_unavailable", "Check tracker reachability and certified complete-read health, then retry without changing the baseline."); }
    const { result, patches } = planTodoEditingSession(session, text, items);
    // Untrusted identity tokens must not expand otherwise bounded agent receipts.
    result.refusals = result.refusals.map(row => {
      if (row.id !== undefined && row.id.length > 128) { const { id: _id, ...compact } = row; return compact; }
      return row;
    });
    if (!result.ok) return { ...refusal("plan_refused", "Resolve the bounded session refusals, then save the file again; no tracker changes were applied."), result };
    if (patches.length > config.maxChanges) return refusal("change_limit", "Split the editing session or increase maxChanges within its hard ceiling; the entire proposal was retained at source.");
    const sessionRevision = hash(session);
    const trackerRevision = hash([...items].sort((a, b) => a.id.localeCompare(b.id)));
    const binding = hash([config.file, config.pmRoot, sessionRevision]);
    const proposal: TodoChangeProposal = { version: 2, id: hash([2, sourceRevision, sessionRevision, trackerRevision]), sourceRevision, sessionRevision, trackerRevision, text, result, patches: persistablePatches(patches) };
    let release: (() => Promise<void>) | undefined;
    try {
      await mkdir(config.spool, { recursive: true, mode: 0o700 });
      release = await acquireLock(config.spool, "todo-source-watcher", 60, "pm-todos-watcher", false, false, 1000, { maxWaitMs: 1000 });
      const queueFile = join(config.spool, "proposals.json");
      let queue: Queue = { version: 2, binding, proposals: [] };
      if ((await readdir(config.spool)).includes("proposals.json")) {
        queue = JSON.parse(await boundedRead(queueFile, 16_777_216)) as Queue;
        if (queue.version !== 2 || queue.binding !== binding || !Array.isArray(queue.proposals) || queue.proposals.some(row => row.version !== 2 || row.id !== hash([2, row.sourceRevision, row.sessionRevision, row.trackerRevision]) || row.sourceRevision !== hash(row.text))) return refusal("spool_mismatch", "Preserve the existing queue for review; use a fresh spool for a legacy queue format or another source, tracker or baseline.");
      }
      if (queue.proposals.some(row => row.id === proposal.id)) return { ok: true, state: "duplicate", pending: queue.proposals.length, proposalId: proposal.id };
      if (queue.proposals.length >= config.maxPending) return refusal("queue_full", "Review and archive the queue, then restart with a fresh spool; pending proposals were preserved.");
      // A writer may have changed the source during the complete tracker read.
      if (hash(await boundedRead(config.file, config.maxBytes)) !== sourceRevision || hash(JSON.parse(await boundedRead(config.sessionFile, config.maxBytes * 8))) !== sessionRevision) { this.candidate = undefined; return refusal("source_unstable", "Wait for the source and sidecar to stop changing, then retry."); }
      queue.proposals.push(proposal);
      const serialized = JSON.stringify(queue);
      if (Buffer.byteLength(serialized) > 16_777_216) return refusal("queue_full", "Archive the queue and use a fresh spool; the queue byte ceiling is 16 MiB.");
      await writeFileAtomic(queueFile, serialized);
      return { ok: true, state: "queued", pending: queue.proposals.length, proposalId: proposal.id, changed: patches.length, omitted: result.omitted };
    } catch { return refusal("spool_unavailable", "Restore writable spool access and preserve its contents; retry to deduplicate any completed write."); }
    finally { if (release) await release(); }
  }
  /** Complete one stable cycle within max(1000 ms, 3 * stableMs); in-flight I/O finishes normally. */
  async runOnce(): Promise<TodoWatcherReceipt> {
    const stableMs = this.config?.stableMs ?? 500;
    const deadline = this.clock.now() + Math.max(1000, 3 * stableMs);
    while (this.clock.now() < deadline) {
      const result = await this.poll();
      if (result.state !== "waiting") return result;
      const remaining = deadline - this.clock.now();
      if (remaining > 0) await this.clock.sleep(Math.max(1, Math.ceil(Math.min(stableMs, this.config?.pollMs ?? 100, remaining))));
    }
    return refusal("still_waiting", "The one-shot stability budget expired; stop the source writer and retry, or use --follow to keep observing changes.");
  }
  /** Run until cancellation, awaiting each receipt and finishing in-flight persistence. */
  async run(signal: AbortSignal, emit: (receipt: TodoWatcherReceipt) => void | Promise<void>): Promise<void> {
    const interval = this.config?.pollMs ?? 100;
    let previous = "";
    while (!signal.aborted) {
      const receipt = await this.poll();
      const key = JSON.stringify(receipt);
      if (key !== previous) { await emit(receipt); previous = key; }
      if (!signal.aborted) { try { await delay(interval, undefined, { signal }); } catch { /* Cancellation ends polling after persistence. */ } }
    }
  }
}

/** Host output renders one cycle as TOON/JSON; follow mode uses SDK NDJSON framing. */
export async function runTodoWatchCommand(ctx: CommandHandlerContext, clock: TodoWatcherClock = systemClock): Promise<unknown> {
  const config: TodoWatcherOptions = { pmRoot: ctx.pm_root, file: String(ctx.options.file ?? ""), sessionFile: String(ctx.options.session ?? ""), spool: String(ctx.options.spool ?? "") };
  for (const [flag, name] of [["stable-ms", "stableMs"], ["poll-ms", "pollMs"], ["max-bytes", "maxBytes"], ["max-changes", "maxChanges"], ["max-pending", "maxPending"]] as const) {
    const value = ctx.options[flag] ?? ctx.options[name];
    if (value !== undefined) config[name] = Number(value);
  }
  const watcher = new TodoSourceWatcher(config, clock);
  if (!ctx.options.follow) {
    const result = await watcher.runOnce();
    if (!result.ok) process.exitCode = EXIT_CODE.GENERIC_FAILURE;
    return result;
  }
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await watcher.run(controller.signal, receipt => {
      process.stdout.write(`${serializeNdjsonRows([receipt])}\n`);
      if (receipt.refusal?.code === "invalid_options") { process.exitCode = EXIT_CODE.USAGE; controller.abort(); }
    });
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  return suppressHostOutput();
}
