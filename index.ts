// pm-todos — Markdown TODO round-trip for pm-cli

import type {
  CommandHandlerContext,
  ExtensionApi,
  ExtensionModule,
  ImportExportContext,
  PreflightOverrideContext,
} from "@unbrained/pm-cli/sdk/authoring";
import { certifyCompleteListResult, EXIT_CODE, inspectCompleteListResult } from "@unbrained/pm-cli/sdk";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, resolve, join, relative, sep } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";



// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property.
// Use the same public SDK peer that certifies tracker reads so package and host
// contracts cannot drift independently.

class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TodoItem {
  checked: boolean;
  text: string;
  indent: number;
  lineNumber: number;
  /** Section header (`## …`) this item lives under, if any. Used as a tag. */
  section?: string;
  /** Priority inferred from `(p1)` / `!` markers (0 = highest). */
  priority?: number;
  /** Markdown metadata token `due:YYYY-MM-DD`, mapped to pm deadline. */
  deadline?: string;
  /** Source file the item was parsed from (absolute path). */
  file?: string;
  /**
   * pm id parsed out of a trailing `<!-- pm-id -->` provenance comment (the same
   * comment the exporter emits). Lets `--upsert` re-import update the original
   * item instead of creating a duplicate. Undefined when no comment is present.
   */
  pmId?: string;
  /**
   * Item type parsed out of the trailing ` [Type]` annotation the exporter emits
   * on open items (e.g. `- [ ] Title [Feature] <!-- pm-id -->`). Only captured
   * on lines that also carry a `<!-- pm-id -->` provenance comment, so a
   * round-trip restores the original type instead of resetting it to the import
   * default. Undefined for hand-written lines or when no type tag is present.
   */
  itemType?: string;
}

interface PmItem {
  id: string;
  title: string;
  description?: string;
  status: string;
  type?: string;
  priority?: number;
  tags?: string[];
  deadline?: string;
  assignee?: string;
  sprint?: string;
  created_at?: string;
  updated_at?: string;
  /**
   * Optional todo.txt creation date (`YYYY-MM-DD`). When present, emitted on
   * todo.txt export. Used to carry a parsed creation date through round-trips.
   */
  creationDate?: string;
  /**
   * Optional todo.txt completion date (`YYYY-MM-DD`). When present and the item
   * is done, emitted right after the `x` marker on todo.txt export.
   */
  completionDate?: string;
  /**
   * Arbitrary todo.txt `key:value` metadata (e.g. `rec:1w`, `id:gh-123`)
   * preserved verbatim so it survives a todo.txt round-trip.
   */
  kv?: Record<string, string>;
  /** pm-todos extension fields used to preserve source-only JSONL metadata. */
  todos_kv?: Record<string, string>;
  todos_creation_date?: string;
  todos_completion_date?: string;
  todos_source_created_at?: string;
  todos_source_updated_at?: string;
}

interface PiTodo {
  id: number;
  text: string;
  done: boolean;
}

interface PiTodoDetails {
  action: "list" | "add" | "toggle" | "clear";
  todos: PiTodo[];
  nextId: number;
  error?: string;
}

type TodoImportFormat = "markdown" | "todotxt" | "todojson" | "jsonl" | "checkbox";
type TodoExportFormat = "markdown" | "todotxt" | "tasklist" | "todojson" | "jsonl" | "checkbox";

/** Priority-rendering scheme for markdown/tasklist metadata tokens. */
type PriorityMapScheme = "number" | "letter";

// ---------------------------------------------------------------------------
// Markdown TODO parser
// ---------------------------------------------------------------------------

// A checkbox line: optional leading whitespace, a `-`/`*`/`+` bullet, then the
// `[ ]` / `[x]` marker, then the text. Indentation is preserved to detect
// nested sub-tasks.
const TODO_RE = /^(\s*)[-*+] \[([ xX])\] (.+)$/;
// A markdown section header (`## Title`, any level). We treat the heading text
// as a tag for every TODO that follows it (until the next heading). The heading
// capture is greedy and always succeeds when the prefix matches, avoiding the
// polynomial backtracking of `(.+?)\s*#*$` on long adversarial inputs. Trailing
// `#` closures (ATX style: `## Title ##`) are stripped in code after matching.
const HEADER_RE = /^(#{1,6})\s+(.+)$/;

/**
 * Read a boolean option honoring both the kebab-case long flag and the
 * camelCase key the runtime normalizes it to (e.g. `--dry-run` -> `dryRun`).
 * Without this, `ctx.options["dry-run"]` is silently `undefined`.
 */
function readBoolOption(options: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (options[key] !== undefined) return Boolean(options[key]);
  }
  return false;
}

/**
 * Read the first defined string option among the given keys (handles both the
 * kebab-case and camelCase forms the runtime may use, e.g. `closed-as` /
 * `closedAs`).
 */
function readStringOption(options: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = options[key];
    if (v !== undefined && v !== null) return String(v);
  }
  return undefined;
}

/**
 * Read and validate the import `--format` option (markdown | todotxt).
 * Defaults to markdown (current behaviour). Throws a USAGE CommandError on an
 * unrecognised value so typos fail loudly instead of silently importing nothing.
 */
function readImportFormat(options: Record<string, unknown>): TodoImportFormat {
  const raw = readStringOption(options, "format");
  if (raw === undefined) return "markdown";
  const v = raw.toLowerCase();
  if (v === "markdown" || v === "md") return "markdown";
  if (v === "todotxt" || v === "todo.txt") return "todotxt";
  if (v === "todojson" || v === "todo-json" || v === "todo" || v === "pi-todo" || v === "pi-todos") {
    return "todojson";
  }
  // JSON Lines: one PmItem-shaped JSON object per line. Round-trips the full
  // pm item payload (id/status/type/priority/tags/deadline/…) without the
  // section/group conventions of the markdown/tasklist formats.
  if (v === "jsonl" || v === "json-lines" || v === "jsonline" || v === "json-line") {
    return "jsonl";
  }
  // Flat checkbox markdown: `- [ ]`/`- [x]` lines only, no `# TODO` header and
  // no `## Open`/`## Done` sections. The import grammar is identical to the
  // default `markdown` parser, so `checkbox` is a pure export-side variant.
  if (v === "checkbox" || v === "checkbox-md" || v === "checkbox-markdown") {
    return "checkbox";
  }
  throw new CommandError(`Unknown --format '${raw}' (expected markdown|todotxt|todojson|jsonl|checkbox)`, EXIT_CODE.USAGE);
}

/**
 * Read and validate the export `--format` option (markdown | todotxt | tasklist).
 */
function readExportFormat(options: Record<string, unknown>): TodoExportFormat {
  const raw = readStringOption(options, "format");
  if (raw === undefined) return "markdown";
  const v = raw.toLowerCase();
  if (v === "markdown" || v === "md") return "markdown";
  if (v === "todotxt" || v === "todo.txt") return "todotxt";
  if (v === "tasklist" || v === "task-list" || v === "gfm") return "tasklist";
  if (v === "todojson" || v === "todo-json" || v === "todo" || v === "pi-todo" || v === "pi-todos") {
    return "todojson";
  }
  if (v === "jsonl" || v === "json-lines" || v === "jsonline" || v === "json-line") {
    return "jsonl";
  }
  if (v === "checkbox" || v === "checkbox-md" || v === "checkbox-markdown") {
    return "checkbox";
  }
  throw new CommandError(`Unknown --format '${raw}' (expected markdown|todotxt|tasklist|todojson|jsonl|checkbox)`, EXIT_CODE.USAGE);
}

/**
 * Read and validate the `--group-by` option (status | sprint | type).
 */
function readGroupBy(options: Record<string, unknown>): string | undefined {
  const raw = readStringOption(options, "group-by", "groupBy");
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v === "status" || v === "sprint" || v === "type") return v;
  throw new CommandError(`Unknown --group-by '${raw}' (expected status|sprint|type)`, EXIT_CODE.USAGE);
}

/**
 * Read and validate the export `--sort` option (priority | deadline | title).
 * Returns undefined when absent (preserves pm's native ordering).
 */
function readSort(options: Record<string, unknown>): "priority" | "deadline" | "title" | undefined {
  const raw = readStringOption(options, "sort");
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v === "priority" || v === "deadline" || v === "title") return v;
  throw new CommandError(`Unknown --sort '${raw}' (expected priority|deadline|title)`, EXIT_CODE.USAGE);
}

/**
 * Read and validate the export `--priority-map` option (number | letter).
 * `number` (default) emits `(p0)`..`(p4)` tokens in markdown/tasklist metadata;
 * `letter` emits todo.txt-style `(A)`..`(E)` letters instead. Unknown values throw
 * a USAGE error so typos surface before any export write.
 */
function readPriorityMap(options: Record<string, unknown>): PriorityMapScheme {
  const raw = readStringOption(options, "priority-map", "priorityMap");
  if (raw === undefined) return "number";
  const v = raw.toLowerCase();
  if (v === "number" || v === "numbers" || v === "num" || v === "p") return "number";
  if (v === "letter" || v === "letters" || v === "alpha" || v === "a") return "letter";
  throw new CommandError(`Unknown --priority-map '${raw}' (expected number|letter)`, EXIT_CODE.USAGE);
}

/**
 * Parse a `--filter <expr>` option into discrete status/type predicates.
 * Accepts a comma-separated list of `key=value` or `key:value` pairs where the
 * only recognized keys are `status` and `type` (e.g. `status=open`,
 * `type:Task`, or `status=open,type=Task`). Repeated keys take the last value.
 * Returns undefined when no `--filter` option is present. Throws a USAGE
 * error on an unrecognised key so a typo like `--filter statis=open` fails
 * loudly instead of silently matching nothing.
 */
export function parseFilterExpression(raw: string | undefined): { status?: string; type?: string } | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const out: { status?: string; type?: string } = {};
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === "") continue;
    const sep = token.includes("=") ? "=" : ":";
    const idx = token.indexOf(sep);
    if (idx <= 0) {
      throw new CommandError(`Invalid --filter '${raw}' (expected key=value, e.g. status=open,type=Task)`, EXIT_CODE.USAGE);
    }
    const key = token.slice(0, idx).trim().toLowerCase();
    const value = token.slice(idx + 1).trim();
    if (key !== "status" && key !== "type") {
      throw new CommandError(`Unknown --filter key '${key}' (expected status|type)`, EXIT_CODE.USAGE);
    }
    if (value === "") {
      throw new CommandError(`Invalid --filter '${raw}' (value for '${key}' must not be empty)`, EXIT_CODE.USAGE);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Merge the explicit `--status`/`--type` options with a `--filter` expression
 * into a single {status?, type?} predicate. The explicit option wins when both
 * name the same key (a redundant `--filter` does not override an explicit flag).
 * Returns undefined when neither source provides a predicate.
 */
function readExportFilter(options: Record<string, unknown>): { status?: string; type?: string } {
  const status = readStringOption(options, "status");
  const type = readStringOption(options, "type");
  const filter = parseFilterExpression(readStringOption(options, "filter"));
  return {
    status: status ?? filter?.status,
    type: type ?? filter?.type,
  };
}

/**
 * Read a bounded integer option (strict base-10 digits only). Throws a USAGE
 * error on invalid values so bad agent/user input fails loudly.
 */
function readBoundedIntOption(
  options: Record<string, unknown>,
  config: { key: string; label: string; min: number; max: number; defaultValue: number },
): number {
  const raw = readStringOption(options, config.key);
  if (raw === undefined) return config.defaultValue;
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new CommandError(`Invalid ${config.label} '${raw}' (expected an integer ${config.min}-${config.max})`, EXIT_CODE.USAGE);
  }
  const n = Number.parseInt(normalized, 10);
  if (n < config.min || n > config.max) {
    throw new CommandError(`Invalid ${config.label} '${raw}' (expected ${config.min}-${config.max})`, EXIT_CODE.USAGE);
  }
  return n;
}

/**
 * Return a new, stably-sorted copy of `items` by the requested key:
 *   - priority: ascending (0 = highest first); missing priority sorts last
 *   - deadline: ascending ISO date; missing deadline sorts last
 *   - title:    case-insensitive alphabetical
 * Pure (does not mutate the input). Undefined `sort` returns the input as-is.
 */
export function sortItems(items: PmItem[], sort: "priority" | "deadline" | "title" | undefined): PmItem[] {
  if (!sort) return items;
  const copy = [...items];
  if (sort === "priority") {
    copy.sort((a, b) => {
      const pa = a.priority ?? Number.POSITIVE_INFINITY;
      const pb = b.priority ?? Number.POSITIVE_INFINITY;
      return pa - pb;
    });
  } else if (sort === "deadline") {
    copy.sort((a, b) => {
      const da = a.deadline ?? "￿";
      const db = b.deadline ?? "￿";
      return da < db ? -1 : da > db ? 1 : 0;
    });
  } else {
    copy.sort((a, b) => (a.title ?? "").toLowerCase().localeCompare((b.title ?? "").toLowerCase()));
  }
  return copy;
}

interface TodoContextBuildOptions {
  /** Maximum number of focus items to include in the snapshot. */
  limit: number;
  /** Optional explicit focus ordering; default uses triage-friendly ordering. */
  sort?: "priority" | "deadline" | "title";
  /** Include tags on each focus row (off by default to save tokens). */
  includeTags?: boolean;
  /** Optional fixed clock for tests. */
  nowIso?: string;
  /** Optional filter metadata echoed in the result payload. */
  statusFilter?: string;
  /** Optional filter metadata echoed in the result payload. */
  typeFilter?: string;
}

/**
 * One TODO projected into a context snapshot's focus list.
 *
 * Carries only the fields an agent needs to triage or act, not the full pm
 * item: the optionals are absent when the source item has no value for them,
 * so a consumer can distinguish "no deadline" from a deadline that happens to
 * be empty. Serialized into {@link TodoContextSnapshot.focus}.
 */
export interface TodoContextFocusItem {
  id: string;
  title: string;
  status: string;
  type?: string;
  priority?: number;
  deadline?: string;
  assignee?: string;
  sprint?: string;
  tags?: string[];
}

export interface TodoContextSnapshot {
  generatedAt: string;
  filters: {
    status?: string;
    type?: string;
    sort: "triage" | "priority" | "deadline" | "title";
    limit: number;
  };
  totalMatched: number;
  focusCount: number;
  counts: {
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    highPriority: number;
    overdue: number;
    dueWithin7Days: number;
    withoutDeadline: number;
  };
  focus: TodoContextFocusItem[];
}

const CONTEXT_STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  blocked: 1,
  open: 2,
  draft: 3,
  closed: 4,
  canceled: 5,
};

function normalizeDeadlineDate(deadline?: string): string | undefined {
  if (!deadline) return undefined;
  const m = /(\d{4}-\d{2}-\d{2})/.exec(deadline);
  return m?.[1];
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

/**
 * Project a count map onto a count-descending plain record.
 *
 * The entries are sorted by count (highest first) and ties are broken with
 * `compareKeys` when supplied, otherwise a case-insensitive locale compare, so
 * the resulting object is reproducible rather than in map insertion order.
 * `Object.fromEntries` preserves that insertion order for the labels this is
 * called with - statuses and item types - so a consumer iterating the record
 * sees the most significant counts first. The guarantee is not universal: a
 * JavaScript object always enumerates integer-like keys (`"0"`, `"1"`) in
 * ascending numeric order regardless of insertion, so passing array-index-shaped
 * labels would silently discard the sort. Use a `Map` if such labels ever become
 * possible here.
 *
 * @param countMap - Counts keyed by a status, type, or other non-numeric label.
 * @param compareKeys - Optional tie-breaker over the keys; defaults to a
 *   case-insensitive locale compare.
 * @returns A record whose key order mirrors the sort, for non-integer-like keys.
 */
function toSortedCountRecord(
  countMap: Map<string, number>,
  compareKeys?: (a: string, b: string) => number,
): Record<string, number> {
  const entries = [...countMap.entries()];
  entries.sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    if (compareKeys) return compareKeys(a[0], b[0]);
    return compareText(a[0], b[0]);
  });
  return Object.fromEntries(entries);
}

/**
 * Default focus ordering for `pm todos context`: active work first, then
 * urgency (priority/deadline), then recent updates.
 */
export function sortItemsForContext(items: PmItem[]): PmItem[] {
  const copy = [...items];
  copy.sort((a, b) => {
    const statusRankA = CONTEXT_STATUS_ORDER[a.status] ?? 99;
    const statusRankB = CONTEXT_STATUS_ORDER[b.status] ?? 99;
    if (statusRankA !== statusRankB) return statusRankA - statusRankB;

    const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
    const priorityB = b.priority ?? Number.POSITIVE_INFINITY;
    if (priorityA !== priorityB) return priorityA - priorityB;

    const dueA = normalizeDeadlineDate(a.deadline) ?? "9999-12-31";
    const dueB = normalizeDeadlineDate(b.deadline) ?? "9999-12-31";
    if (dueA !== dueB) return dueA.localeCompare(dueB);

    const updatedA = a.updated_at ?? "";
    const updatedB = b.updated_at ?? "";
    if (updatedA !== updatedB) return updatedB.localeCompare(updatedA);

    return compareText(a.title ?? "", b.title ?? "");
  });
  return copy;
}

/**
 * Build a compact, high-signal context payload for agents:
 * aggregate counts + a bounded focus list.
 */
export function buildTodoContextSnapshot(items: PmItem[], options: TodoContextBuildOptions): TodoContextSnapshot {
  const generatedAt = options.nowIso ?? new Date().toISOString();
  const today = generatedAt.slice(0, 10);
  const todayEpoch = Date.parse(`${today}T00:00:00.000Z`);
  const soonEpoch = todayEpoch + 7 * 24 * 60 * 60 * 1000;

  let highPriority = 0;
  let overdue = 0;
  let dueWithin7Days = 0;
  let withoutDeadline = 0;
  const byStatusMap = new Map<string, number>();
  const byTypeMap = new Map<string, number>();

  for (const item of items) {
    const status = (item.status ?? "").trim() || "(unknown)";
    const type = (item.type ?? "").trim() || "(none)";
    byStatusMap.set(status, (byStatusMap.get(status) ?? 0) + 1);
    byTypeMap.set(type, (byTypeMap.get(type) ?? 0) + 1);

    if ((item.priority ?? Number.POSITIVE_INFINITY) <= 1) {
      highPriority++;
    }

    const due = normalizeDeadlineDate(item.deadline);
    if (!due) {
      withoutDeadline++;
      continue;
    }

    const dueEpoch = Date.parse(`${due}T00:00:00.000Z`);
    if (Number.isNaN(dueEpoch)) {
      withoutDeadline++;
      continue;
    }
    if (dueEpoch < todayEpoch) {
      overdue++;
    } else if (dueEpoch <= soonEpoch) {
      dueWithin7Days++;
    }
  }

  const ordered = options.sort ? sortItems(items, options.sort) : sortItemsForContext(items);
  const focus = ordered.slice(0, options.limit).map((item) => {
    const row: TodoContextFocusItem = {
      id: item.id,
      title: item.title,
      status: item.status,
      type: item.type,
      priority: item.priority,
      deadline: normalizeDeadlineDate(item.deadline),
      assignee: item.assignee,
      sprint: item.sprint,
    };
    if (options.includeTags && item.tags && item.tags.length > 0) {
      row.tags = [...item.tags];
    }
    return row;
  });

  return {
    generatedAt,
    filters: {
      status: options.statusFilter,
      type: options.typeFilter,
      sort: options.sort ?? "triage",
      limit: options.limit,
    },
    totalMatched: items.length,
    focusCount: focus.length,
    counts: {
      byStatus: toSortedCountRecord(
        byStatusMap,
        (a, b) => (CONTEXT_STATUS_ORDER[a] ?? 99) - (CONTEXT_STATUS_ORDER[b] ?? 99) || compareText(a, b),
      ),
      byType: toSortedCountRecord(byTypeMap),
      highPriority,
      overdue,
      dueWithin7Days,
      withoutDeadline,
    },
    focus,
  };
}

/**
 * Strip priority markers from a TODO's text and return the inferred priority.
 *
 * Recognised markers (case-insensitive), anywhere in the text:
 *   - `(p0)`..`(p4)`  → that numeric priority
 *   - trailing/leading `!`, `!!`, `!!!` → 0, 1, 2 (more bangs = higher)
 *
 * Returns the cleaned text plus the inferred priority (undefined if none).
 */
function extractPriority(text: string): { text: string; priority?: number } {
  let priority: number | undefined;
  let cleaned = text;

  const pMatch = /\(p([0-4])\)/i.exec(cleaned);
  if (pMatch) {
    priority = parseInt(pMatch[1], 10);
    cleaned = cleaned.replace(pMatch[0], "");
  }

  // Bang markers: only count a contiguous run of `!` that is its own token
  // (surrounded by start/space/end) so we don't strip "!" inside words.
  const bangMatch = /(^|\s)(!{1,3})(?=\s|$)/.exec(cleaned);
  if (bangMatch && priority === undefined) {
    priority = Math.max(0, 3 - bangMatch[2].length); // ! -> 2, !! -> 1, !!! -> 0
    cleaned = cleaned.replace(bangMatch[0], bangMatch[1]);
  }

  return { text: cleaned.replace(/\s+/g, " ").trim(), priority };
}

/**
 * Pull a `due:YYYY-MM-DD` marker out of a markdown TODO and strip it.
 *
 * Matches a `due:` date only when it is a whole token (bounded by whitespace
 * or the string edges), so a date embedded in a word is left alone. The marker
 * is removed from the returned `text` and surrounding whitespace collapsed, so
 * the line reads cleanly whether or not it carried a due date; the date itself
 * is returned in `deadline` only on a match.
 *
 * @param text - One markdown TODO line, possibly carrying a `due:` marker.
 * @returns The cleaned text and the captured deadline, or no deadline on miss.
 */
export function extractMarkdownDue(text: string): { text: string; deadline?: string } {
  const dueRe = /(^|\s)due:(\d{4}-\d{2}-\d{2})(?=\s|$)/;
  const match = dueRe.exec(text);
  if (!match) return { text };
  const before = text.slice(0, match.index) + match[1];
  const after = text.slice(match.index + match[0].length);
  return {
    text: `${before}${after}`.replace(/\s+/g, " ").trim(),
    deadline: match[2],
  };
}

/**
 * Strip a trailing `regex` match from `text` (the regex MUST anchor to `$` and
 * capture the payload in group 1) and return the cleaned text plus the trimmed
 * capture. When the regex does not match, `value` is undefined and `text` is
 * returned unchanged. Shared by `extractPmIdComment` and `extractTypeTag`.
 */
function extractTrailing(text: string, regex: RegExp): { text: string; value?: string } {
  const m = regex.exec(text);
  if (!m) return { text };
  const value = m[1]?.trim();
  return { text: text.slice(0, m.index).trim(), value: value || undefined };
}

// A trailing `<!-- pm-id -->` provenance comment, exactly as the exporter emits
// it (`- [ ] Title <!-- pm-abc123 -->`). The capture is constrained to pm-cli's
// item-id grammar — one or more alphanumeric segments joined by hyphens
// (`pm-uhkv`, `pm-todos-982k`, `bug-3f2a`): the configurable id prefix always
// contributes at least one hyphen. This deliberately does NOT match a free-form
// trailing comment such as `<!-- note -->` or `<!-- see figure 1 -->`, so a
// hand-written line is never mistaken for provenance — which would otherwise
// set a bogus `pmId` AND, via the type-tag gate below, strip a legitimate
// trailing `[WIP]` from the title.
// NOTE: no leading `\s*` — the `.trim()` in `extractTrailing` already cleans the
// text before the match, and a leading `\s*` causes polynomial backtracking
// because the engine retries it at every position in a long whitespace run.
const PM_ID_COMMENT_RE = /<!--\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\s*-->\s*$/;

/**
 * Strip a trailing `<!-- pm-id -->` comment from a TODO's text and return the
 * cleaned text plus the captured id. When there is no provenance comment, `id`
 * is undefined and `text` is returned unchanged (a non-id trailing comment is
 * left in the title verbatim). Only the LAST trailing comment is consumed (the
 * exporter always emits exactly one, at end of line).
 */
export function extractPmIdComment(text: string): { text: string; id?: string } {
  const { text: cleaned, value } = extractTrailing(text, PM_ID_COMMENT_RE);
  return { text: cleaned, id: value };
}

// pm's built-in item types (`pm schema list`). The exporter normalizes aliases
// before emitting (e.g. `bug` → `Issue`), and pm rejects unregistered types at
// create time, so a trailing tag is only a real type tag when it is EXACTLY one
// of these. Matching the closed set — rather than a generic Title-Case shape —
// means a title that naturally ends in another capitalized bracket
// (`Support [Safari]`, `Deploy to [Staging]`, `Fix [Firefox]`) is never
// mistaken for a type tag and corrupted.
const PM_ITEM_TYPES = [
  "Chore", "Decision", "Epic", "Event", "Feature", "Issue",
  "Meeting", "Milestone", "Plan", "Reminder", "Task",
] as const;

// The exporter appends each open item's type as a trailing ` [Type]` annotation
// (see `renderDefaultMarkdown`: `- [ ] ${title} [${type}] <!-- ${id} -->`). Only
// the LAST such group is consumed, so an item titled `Deploy to [Staging]` keeps
// that bracket and sheds only the real type tag the exporter appended after it.
// No leading `\s*`: `.trim()` in `extractTrailing` handles the whitespace, and a
// leading `\s*` causes polynomial backtracking on long whitespace runs.
const TYPE_TAG_RE = new RegExp(`\\[(${PM_ITEM_TYPES.join("|")})\\]\\s*$`);

/**
 * Strip the exporter's trailing ` [Type]` annotation from a TODO's text and
 * return the cleaned text plus the captured type. The tag must be EXACTLY one
 * of pm's built-in types (`PM_ITEM_TYPES`); otherwise `type` is undefined and
 * `text` is returned unchanged.
 *
 * The caller only applies this to lines that carry a `<!-- pm-id -->` provenance
 * comment, so hand-written titles ending in `[foo]` are never disturbed — this
 * keeps the default (non-round-trip) parse path byte-stable. Matching the exact
 * type set means a title ending in a non-type bracket (`Support [Safari]`) is
 * left intact regardless of the item's open/closed checkbox state.
 */
export function extractTypeTag(text: string): { text: string; type?: string } {
  const { text: cleaned, value } = extractTrailing(text, TYPE_TAG_RE);
  return { text: cleaned, type: value };
}

/**
 * Decide the title and type to apply when upserting onto an EXISTING item.
 *
 * `parsedText`/`parsedType` come from the imported line (the type tag, if any,
 * already split off). The exporter omits the type tag on closed items, so a
 * closed item titled `Complete [Task]` parses to text `Complete` + type `Task`
 * — but its real title ends in `[Task]`. When re-attaching the parsed tag
 * reproduces the matched item's stored title, the bracket was title content,
 * not a round-trip type tag: restore the RAW stored title and drop the spurious
 * type. A genuine open-export-then-ticked line (`Implement login [Feature]`,
 * stored title `Implement login`) does not reproduce the stored title, so its
 * type tag is preserved.
 *
 * Whitespace is normalised for the comparison only (the parser collapses runs
 * of whitespace in `parsedText`), while the original `existingTitle` is restored
 * verbatim so its exact spacing survives.
 */
export function resolveUpsertTitleType(
  parsedText: string,
  parsedType: string | undefined,
  existingTitle: string | undefined,
): { title: string; type?: string } {
  if (
    parsedType &&
    existingTitle &&
    existingTitle.replace(/\s+/g, " ").trim() === `${parsedText} [${parsedType}]`
  ) {
    return { title: existingTitle, type: undefined };
  }
  return { title: parsedText, type: parsedType };
}

/**
 * Normalise a section heading into a tag-safe slug (lowercase, dashes).
 */
function sectionToTag(section: string): string {
  return section
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Parse a markdown string into TODO items.
 *
 * Supports:
 *  - `-`/`*`/`+` bullets with `[ ]` / `[x]` checkboxes
 *  - nested/indented sub-tasks (indentation captured on `.indent`)
 *  - section headers (`## Foo`) attached to every following item as `.section`
 *  - priority markers (`(p1)`, `!`/`!!`/`!!!`) parsed out of the text
 *
 * @param file  absolute source path recorded on each item (for provenance)
 */
export function parseMarkdownTodos(md: string, file?: string): TodoItem[] {
  const lines = md.split("\n");
  const todos: TodoItem[] = [];
  let currentSection: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const header = HEADER_RE.exec(line);
    if (header) {
      // Strip ATX closing `#`s (e.g. `## Title ##`) and trim whitespace.
      // Scanned backwards rather than with `/#*$/`: an unanchored `#*` that the
      // engine retries at every start position is quadratic on a long run of
      // `#`, measured here at 5.4 seconds for 64000 of them. A backward scan is
      // linear and needs no backtracking.
      const heading = header[2];
      let end = heading.length;
      while (end > 0 && heading[end - 1] === "#") end -= 1;
      currentSection = heading.slice(0, end).trim();
      continue;
    }

    const match = TODO_RE.exec(line);
    if (match) {
      const raw = match[3].trim();
      const checked = match[2] !== " ";
      // Strip a trailing `<!-- pm-id -->` provenance comment first so it never
      // becomes part of the title or interferes with priority-marker parsing.
      const { text: withoutId, id: pmId } = extractPmIdComment(raw);
      // Then, on any line carrying provenance (a pm-id comment), strip the
      // exporter's trailing ` [Type]` annotation and capture it so a round-trip
      // restores the type instead of folding the tag into the title. We do NOT
      // gate on the checkbox: a user who exports open items and then ticks one
      // off (`- [ ] Task [Feature]` → `- [x] Task [Feature]`) before re-importing
      // must still have `[Feature]` recognised as the type tag, not folded into
      // the title. Recognition is by the exact built-in type vocabulary
      // (`PM_ITEM_TYPES`), so a title ending in a non-type bracket
      // (`Support [Safari]`) is never touched; hand-written lines (no pm-id)
      // keep any trailing `[bracket]` verbatim.
      const { text: withoutType, type: itemType } = pmId
        ? extractTypeTag(withoutId)
        : { text: withoutId, type: undefined };
      const { text, priority } = extractPriority(withoutType);
      const { text: withoutDue, deadline } = extractMarkdownDue(text);
      todos.push({
        indent: match[1].replace(/\t/g, "    ").length,
        checked,
        text: withoutDue,
        priority,
        deadline,
        section: currentSection,
        lineNumber: i + 1,
        file,
        pmId,
        itemType,
      });
    }
  }
  return todos;
}

/**
 * Filter parsed todos to a single section (matched case-insensitively against
 * the raw heading text).
 */
function filterBySection(todos: TodoItem[], section: string): TodoItem[] {
  const want = section.trim().toLowerCase();
  return todos.filter((t) => (t.section ?? "").toLowerCase() === want);
}

function mapStatusToPm(checked: boolean, closedAs: string, openAs = "open"): string {
  return checked ? closedAs : openAs;
}

function mapPmStatusToChecked(status: string): boolean {
  return status === "closed" || status === "canceled";
}

/**
 * Whether a resolved pm status is terminal (closed/canceled). pm refuses to
 * CREATE or UPDATE an item directly into a terminal status without a close
 * reason whenever `governance.require_close_reason` is enabled — and that
 * policy is a built-in default, so this is the out-of-the-box path. The import
 * create/update paths must therefore attach a close reason for every terminal
 * status they write, or the item is rejected and the line is lost.
 */
export function isTerminalStatus(status: string): boolean {
  return status === "closed" || status === "canceled";
}

/**
 * Build the traceable close reason an imported completed/canceled line carries
 * into the pm store. The source file and line number are already known at the
 * call site, so the reason names them — making the immutable closure evidence
 * reconstructable from the originating TODO file rather than invented. Mirrors
 * the `Imported from <file> line <n>` provenance string already written to the
 * item description so the two records agree.
 */
export function buildImportCloseReason(status: string, file: string | undefined, lineNumber: number): string {
  return `Imported as ${status} from ${file ?? "stdin"} line ${lineNumber}`;
}

/**
 * A handler result carrying the partial-import report.
 *
 * `Omit` is deliberate rather than a plain intersection: a base result that
 * already declared `dropped` or `exit_code` would otherwise intersect into an
 * impossible type (`string & DroppedTodoLine[]`), which typed callers cannot
 * consume. Omitting first lets the report's own fields win, which matches what
 * the spread at runtime actually does.
 */
export type DroppedReportOf<T> = Omit<T, "dropped" | "exit_code"> & {
  /** Every source line that could not be imported, in file order. */
  dropped: DroppedTodoLine[];
  /** Non-zero exit code echoed into the result so structured consumers see it on the normal output path. */
  exit_code: number;
};

/**
 * Apply the partial-import contract to a handler result object. When no line
 * was dropped, the base result is returned unchanged and the process exit code
 * is left untouched (success). When one or more lines were dropped, the
 * per-line `dropped` report and a non-zero `exit_code` are attached to the
 * result so they reach the normal output path (stdout), and `process.exitCode`
 * is set directly so the command exits non-zero.
 *
 * Setting `process.exitCode` directly (rather than relying on the result-level
 * `exit_code` alone) is required because the pm runtime renders an extension
 * importer's RESULT to stdout but does not propagate a result-level `exit_code`
 * to the process exit on the importer dispatch path — the action wrapper
 * renders and returns without reading `exitCode`. A thrown error would exit
 * non-zero but moves the report to stderr, contradicting the "normal output
 * path" requirement. Setting the process exit code directly is the only way to
 * satisfy both: the structured `dropped` report on stdout AND a non-zero exit.
 */
export function withDroppedReport<T extends object>(
  base: T,
  droppedLines: DroppedTodoLine[],
): T | DroppedReportOf<T> {
  if (droppedLines.length === 0) return base;
  process.exitCode = EXIT_CODE.GENERIC_FAILURE;
  return { ...base, dropped: droppedLines, exit_code: EXIT_CODE.GENERIC_FAILURE };
}

// ---------------------------------------------------------------------------
// todo.txt format (https://github.com/todotxt/todo.txt)
// ---------------------------------------------------------------------------

/**
 * A parsed todo.txt line. `raw` is the original line; the structured fields are
 * the de-facto todo.txt grammar:
 *   - leading `x ` marks completion
 *   - `(A)`..`(Z)` is a priority letter
 *   - `+project` and `@context` are tags (collected into `projects`/`contexts`)
 *   - `key:value` pairs (notably `due:YYYY-MM-DD`) are extra metadata
 *   - everything else is the description text
 */
interface TodoTxtItem {
  done: boolean;
  /** Priority letter A..Z (uppercase) or undefined. */
  priorityLetter?: string;
  /** Free-text description with projects/contexts/key:value tokens removed. */
  text: string;
  projects: string[];
  contexts: string[];
  /** `due:` value if present (raw, un-validated date string). */
  due?: string;
  /** All other `key:value` pairs preserved verbatim. */
  kv: Record<string, string>;
  /** Completion date (`x 2026-01-02 …`), preserved if present. */
  completionDate?: string;
  /** Creation date, preserved if present. */
  creationDate?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Render a TODO's pm metadata as a trailing markdown suffix.
 *
 * Emits a priority token and a `due:` date, space-joined and led by a single
 * space, ready to append to a checkbox line. The priority is clamped to the
 * `0`–`4` band pm uses (truncated, never rounded) and rendered through the
 * chosen scheme — `(p0)`…`(p4)` for `number`, `(A)`…`(E)` for `letter` — and is
 * omitted entirely when the item has no priority. The deadline is taken from
 * the first ten characters and only emitted when they satisfy `DATE_RE`, so a
 * malformed deadline never produces a broken `due:` token. Returns an empty
 * string when neither field contributes.
 *
 * @param item - The pm item whose metadata to render.
 * @param priorityMap - How to spell a priority; defaults to the `number` scheme.
 * @returns A leading-space-prefixed suffix, or "" when there is nothing to add.
 */
function markdownMetadataSuffix(item: PmItem, priorityMap: PriorityMapScheme = "number"): string {
  const parts: string[] = [];
  if (item.priority !== undefined && item.priority !== null) {
    const n = Math.max(0, Math.min(4, Math.trunc(item.priority)));
    if (priorityMap === "letter") {
      parts.push(`(${String.fromCharCode(65 + n)})`);
    } else {
      parts.push(`(p${n})`);
    }
  }
  if (item.deadline) {
    const date = item.deadline.slice(0, 10);
    if (DATE_RE.test(date)) parts.push(`due:${date}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * True when `s` is a real ISO calendar date `YYYY-MM-DD` (right shape AND a
 * valid month/day, e.g. rejects `2026-13-99`). Used by validation; the looser
 * `DATE_RE` is fine for serialization where pm already produced the date.
 */
function isValidIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map((n) => parseInt(n, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Map a todo.txt priority letter to a pm numeric priority.
 * todo.txt: `(A)` is highest. pm: `0` is highest.
 * `(A)`→0, `(B)`→1, … `(E)`→4. Letters beyond E (F..Z) clamp to 4 (lowest).
 * Returns undefined for an absent/invalid letter.
 */
export function priorityLetterToPm(letter: string | undefined): number | undefined {
  if (!letter) return undefined;
  const code = letter.toUpperCase().charCodeAt(0);
  if (code < 65 || code > 90) return undefined; // not A..Z
  return Math.min(4, code - 65);
}

/**
 * Map a pm numeric priority to a todo.txt priority letter.
 * `0`→`A`, `1`→`B`, … `4`→`E`. Out-of-range values clamp into A..E.
 * Returns undefined when priority is undefined.
 */
export function pmPriorityToLetter(priority: number | undefined): string | undefined {
  if (priority === undefined || priority === null || Number.isNaN(priority)) return undefined;
  const clamped = Math.max(0, Math.min(4, Math.trunc(priority)));
  return String.fromCharCode(65 + clamped);
}

/**
 * Parse a single todo.txt line into a structured item. Returns null for blank
 * lines (which carry no task).
 */
export function parseTodoTxtLine(line: string): TodoTxtItem | null {
  let rest = line.trim();
  if (rest === "") return null;

  let done = false;
  let completionDate: string | undefined;
  // Completed task: leading `x ` then an optional completion date.
  const doneMatch = /^x\s+(.*)$/.exec(rest);
  if (doneMatch) {
    done = true;
    rest = doneMatch[1].trim();
    const dateMatch = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(rest);
    if (dateMatch) {
      completionDate = dateMatch[1];
      rest = dateMatch[2].trim();
    }
  }

  let priorityLetter: string | undefined;
  const prioMatch = /^\(([A-Z])\)\s+(.*)$/.exec(rest);
  if (prioMatch) {
    priorityLetter = prioMatch[1];
    rest = prioMatch[2].trim();
  }

  // Optional creation date (a leading bare date after the priority).
  let creationDate: string | undefined;
  const createMatch = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(rest);
  if (createMatch) {
    creationDate = createMatch[1];
    rest = createMatch[2].trim();
  }

  const projects: string[] = [];
  const contexts: string[] = [];
  const kv: Record<string, string> = {};
  let due: string | undefined;

  const words = rest.split(/\s+/);
  const textWords: string[] = [];
  for (const w of words) {
    if (w.length > 1 && w[0] === "+") {
      projects.push(w.slice(1));
    } else if (w.length > 1 && w[0] === "@") {
      contexts.push(w.slice(1));
    } else if (/^[^\s:]+:[^\s:]+$/.test(w)) {
      const idx = w.indexOf(":");
      const key = w.slice(0, idx);
      const val = w.slice(idx + 1);
      if (key === "due") due = val;
      else kv[key] = val;
    } else {
      textWords.push(w);
    }
  }

  return {
    done,
    priorityLetter,
    text: textWords.join(" ").trim(),
    projects,
    contexts,
    due,
    kv,
    completionDate,
    creationDate,
  };
}

/**
 * Parse a whole todo.txt document into structured items (blank lines skipped).
 */
export function parseTodoTxt(content: string): TodoTxtItem[] {
  const out: TodoTxtItem[] = [];
  for (const line of content.split("\n")) {
    const item = parseTodoTxtLine(line);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Serialize a single pm item to a todo.txt line. `+project`/`@context` are
 * derived from tags (todo.txt has no separate notion), `due:` from deadline.
 */
export function serializeTodoTxtLine(item: PmItem): string {
  const parts: string[] = [];
  const done = mapPmStatusToChecked(item.status);
  if (done) parts.push("x");

  // Completion date follows the `x` marker (todo.txt: `x <completion> …`).
  // Only meaningful for done items.
  if (done && item.completionDate && DATE_RE.test(item.completionDate)) {
    parts.push(item.completionDate);
  }

  const letter = pmPriorityToLetter(item.priority);
  if (letter && !done) parts.push(`(${letter})`);

  // Creation date sits before the description (after priority on an open item,
  // after the completion date on a done item) — the position the parser reads.
  if (item.creationDate && DATE_RE.test(item.creationDate)) {
    parts.push(item.creationDate);
  }

  parts.push(item.title);

  for (const tag of item.tags ?? []) {
    parts.push(`+${tag}`);
  }
  if (item.deadline) {
    const date = item.deadline.slice(0, 10);
    if (DATE_RE.test(date)) parts.push(`due:${date}`);
  }
  // Arbitrary key:value metadata preserved verbatim (sorted for stable output).
  if (item.kv) {
    for (const key of Object.keys(item.kv).sort()) {
      const val = item.kv[key];
      if (val !== undefined && val !== "") parts.push(`${key}:${val}`);
    }
  }
  return parts.join(" ");
}

/**
 * Convert a parsed todo.txt item into the PmItem shape used by the serializer.
 * Preserves the structured fields (priority, projects/contexts as tags, due as
 * deadline, creation/completion dates, and arbitrary key:value metadata) so a
 * `parse → toPm → serialize` cycle is lossless on all captured fields. Used for
 * round-trip fidelity (and testing); not a pm persistence path.
 */
export function todoTxtItemToPm(item: TodoTxtItem, id = ""): PmItem {
  return {
    id,
    title: item.text,
    status: item.done ? "closed" : "open",
    priority: priorityLetterToPm(item.priorityLetter),
    tags: [...item.projects, ...item.contexts],
    deadline: item.due,
    creationDate: item.creationDate,
    completionDate: item.completionDate,
    kv: Object.keys(item.kv).length > 0 ? { ...item.kv } : undefined,
  };
}

/**
 * Serialize pm items to a todo.txt document (one line per item, trailing NL).
 */
export function serializeTodoTxt(items: PmItem[]): string {
  if (items.length === 0) return "";
  return items.map(serializeTodoTxtLine).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// pi coding-agent todo extension JSON state
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one element of a todojson `todos` array as a {@link PiTodo}.
 *
 * Each field is checked against the shape the pi todo extension emits: `id` is
 * an integer, `text` a string whose trimmed form is non-empty, `done` a
 * boolean. Nothing is coerced or normalised - `text` is returned exactly as it
 * arrived, so surrounding whitespace survives; trimming is used only to reject
 * a value that is entirely blank. Any failure
 * throws a usage {@link CommandError} that names the offending index, so the
 * caller's aggregate error pinpoints the bad entry rather than aborting on a
 * generic "invalid JSON".
 *
 * @param value - One raw element from the parsed todos array.
 * @param index - Position in the array, used in the thrown message.
 * @returns The validated `{ id, text, done }` triple.
 * @throws {CommandError} When `value` is not an object or a field is malformed.
 */
function parsePiTodo(value: unknown, index: number): PiTodo {
  if (!isRecord(value)) {
    throw new CommandError(`todojson item at index ${index} is not an object`, EXIT_CODE.USAGE);
  }
  const { id, text, done } = value;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    throw new CommandError(`todojson item at index ${index} has invalid id (expected integer)`, EXIT_CODE.USAGE);
  }
  if (typeof text !== "string" || text.trim() === "") {
    throw new CommandError(`todojson item at index ${index} has invalid text (expected non-empty string)`, EXIT_CODE.USAGE);
  }
  if (typeof done !== "boolean") {
    throw new CommandError(`todojson item at index ${index} has invalid done (expected boolean)`, EXIT_CODE.USAGE);
  }
  return { id, text, done };
}

/**
 * Parse the todo extension's tool-result details payload. The canonical shape
 * mirrors upstream `todo.ts`: `{ action, todos, nextId }`. For convenience, a
 * raw `Todo[]` array is also accepted.
 */
export function parsePiTodoDetails(content: string): PiTodoDetails {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Invalid todojson: ${msg}`, EXIT_CODE.USAGE);
  }

  const todosRaw = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.todos : undefined;
  if (!Array.isArray(todosRaw)) {
    throw new CommandError("Invalid todojson: expected a TodoDetails object with a todos array", EXIT_CODE.USAGE);
  }

  const todos = todosRaw.map(parsePiTodo);
  const maxId = todos.reduce((max, todo) => Math.max(max, todo.id), 0);
  const nextIdRaw = isRecord(parsed) ? parsed.nextId : undefined;
  const nextId = typeof nextIdRaw === "number" && Number.isInteger(nextIdRaw) && nextIdRaw > maxId
    ? nextIdRaw
    : maxId + 1;
  const actionRaw = isRecord(parsed) ? parsed.action : undefined;
  const action =
    actionRaw === "list" || actionRaw === "add" || actionRaw === "toggle" || actionRaw === "clear"
      ? actionRaw
      : "list";

  return { action, todos, nextId };
}

const TODOJSON_ID_MARKER_RE = /\btodo-id:(\d+)\b/;
const TODOJSON_IMPORTED_DESCRIPTION_RE = /^Imported from .+ line \d+(?: \(todo-id:\d+\))?$/;

/**
 * Extract a persisted todojson source id (`todo-id:<n>`) from an item's
 * description, if present.
 */
export function extractTodojsonSourceId(description: string | undefined): number | undefined {
  if (!description) return undefined;
  const match = TODOJSON_ID_MARKER_RE.exec(description);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Build the import provenance description used by todojson imports. Includes a
 * persisted `todo-id:<n>` marker so later exports can keep todo ids stable.
 */
export function buildTodojsonImportDescription(file: string | undefined, lineNumber: number, todoId?: number): string {
  const base = `Imported from ${file ?? "stdin"} line ${lineNumber}`;
  return todoId !== undefined ? `${base} (todo-id:${todoId})` : base;
}

/**
 * Decide whether an upserted todojson line should refresh an existing item's
 * description with the canonical import-provenance marker.
 */
function shouldRefreshTodojsonDescription(existingDescription: string | undefined, todoId: number): boolean {
  if (!existingDescription) return true;
  const existingId = extractTodojsonSourceId(existingDescription);
  if (existingId !== undefined) return existingId !== todoId;
  return TODOJSON_IMPORTED_DESCRIPTION_RE.test(existingDescription);
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Serialize pm items back into the pi todojson details JSON.
 *
 * Assigns stable todo ids in two passes: first reuse the `todo-id:<n>` marker
 * persisted in each item's description, skipping any id already taken so a
 * duplicate marker cannot collide; then hand out fresh ids to the rest in a
 * deterministic order (created_at, then updated_at, then id, then title),
 * starting one above the highest preserved id. `nextId` is left one past the
 * last assigned id so a subsequent `add` does not reuse one. The emitted todos
 * are ordered by id and mapped to `{ id, text, done }` with `done` derived from
 * the pm status, and the whole payload is pretty-printed with a trailing
 * newline so it round-trips through a text file cleanly.
 *
 * @param items - pm items to export, in any order.
 * @returns A newline-terminated JSON string in the todojson details shape.
 */
export function serializePiTodoDetails(items: PmItem[]): string {
  type Row = { item: PmItem; todoId?: number };
  const rows: Row[] = items.map((item) => ({ item }));
  const usedIds = new Set<number>();

  // First pass: preserve persisted todo ids when present and non-conflicting.
  for (const row of rows) {
    const persisted = extractTodojsonSourceId(row.item.description);
    if (persisted !== undefined && !usedIds.has(persisted)) {
      row.todoId = persisted;
      usedIds.add(persisted);
    }
  }

  // Second pass: assign deterministic new ids to items lacking persisted ids.
  const unassigned = rows
    .filter((row) => row.todoId === undefined)
    .sort((a, b) =>
      parseTimestamp(a.item.created_at) - parseTimestamp(b.item.created_at)
        || parseTimestamp(a.item.updated_at) - parseTimestamp(b.item.updated_at)
        || (a.item.id ?? "").localeCompare(b.item.id ?? "")
        || (a.item.title ?? "").localeCompare(b.item.title ?? ""),
    );

  let nextId = usedIds.size > 0 ? Math.max(...usedIds) + 1 : 1;
  for (const row of unassigned) {
    row.todoId = nextId;
    usedIds.add(nextId);
    nextId += 1;
  }

  const todos = rows
    .sort((a, b) => (a.todoId ?? 0) - (b.todoId ?? 0))
    .map((row) => ({
      id: row.todoId ?? 0,
      text: row.item.title,
      done: mapPmStatusToChecked(row.item.status),
    }));

  const details: PiTodoDetails = {
    action: "list",
    todos,
    nextId,
  };
  return JSON.stringify(details, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// JSON Lines format (one PmItem-shaped JSON object per line)
// ---------------------------------------------------------------------------

/** Keys serialized on each jsonl row (a stable, alphabetical order). */
const JSONL_KEYS = [
  "id", "title", "description", "status", "type", "priority",
  "tags", "deadline", "assignee", "sprint", "created_at", "updated_at",
  "creationDate", "completionDate", "kv",
] as const;

/**
 * Serialize pm items to JSON Lines (one compact JSON object per item, trailing NL).
 * Each row carries the full pm item payload so a jsonl round-trip is lossless
 * on every captured field (unlike markdown, which encodes only a subset).
 * Empty input returns the empty string (no rows, no trailing newline).
 */
export function serializeJsonl(items: PmItem[]): string {
  if (items.length === 0) return "";
  return (
    items
      .map((item) => {
        const row: Record<string, unknown> = {};
        const sourceFields: Partial<Record<(typeof JSONL_KEYS)[number], unknown>> = {
          created_at: item.todos_source_created_at,
          updated_at: item.todos_source_updated_at,
          creationDate: item.todos_creation_date,
          completionDate: item.todos_completion_date,
          kv: item.todos_kv,
        };
        for (const key of JSONL_KEYS) {
          const v = sourceFields[key] ?? (item as unknown as Record<string, unknown>)[key];
          if (v === undefined || v === null) continue;
          if (Array.isArray(v) && v.length === 0) continue;
          if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
          row[key] = v;
        }
        return JSON.stringify(row);
      })
      .join("\n") + "\n"
  );
}

/**
 * Parse a JSON Lines document into pm items. Blank lines are skipped. Each
 * non-blank line MUST be a JSON object with at least a `title` string; `status`
 * defaults to "open" when absent. Other pm fields are passed through when
 * present, so a `serializeJsonl → parseJsonl` cycle is lossless. Throws a USAGE
 * CommandError on malformed JSON or a missing/empty title.
 */
export function parseJsonl(content: string): PmItem[] {
  const out: PmItem[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CommandError(`Invalid jsonl on line ${i + 1}: ${msg}`, EXIT_CODE.USAGE);
    }
    if (!isRecord(parsed)) {
      throw new CommandError(`Invalid jsonl on line ${i + 1} (expected a JSON object)`, EXIT_CODE.USAGE);
    }
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    if (title === "") {
      throw new CommandError(`Invalid jsonl on line ${i + 1}: Missing or empty 'title'`, EXIT_CODE.USAGE);
    }
    const status = typeof parsed.status === "string" && parsed.status !== "" ? parsed.status : "open";
    const item: PmItem = {
      id: typeof parsed.id === "string" ? parsed.id : "",
      title,
      status,
    };
    // Pass through optional fields only when present and well-typed.
    if (typeof parsed.description === "string") item.description = parsed.description;
    if (typeof parsed.type === "string") item.type = parsed.type;
    if (typeof parsed.priority === "number") item.priority = parsed.priority;
    if (Array.isArray(parsed.tags)) item.tags = (parsed.tags as unknown[]).filter((t) => typeof t === "string") as string[];
    if (typeof parsed.deadline === "string") item.deadline = parsed.deadline;
    if (typeof parsed.assignee === "string") item.assignee = parsed.assignee;
    if (typeof parsed.sprint === "string") item.sprint = parsed.sprint;
    if (typeof parsed.created_at === "string") item.created_at = parsed.created_at;
    if (typeof parsed.updated_at === "string") item.updated_at = parsed.updated_at;
    if (typeof parsed.creationDate === "string") item.creationDate = parsed.creationDate;
    if (typeof parsed.completionDate === "string") item.completionDate = parsed.completionDate;
    if (isRecord(parsed.kv)) {
      const kv: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.kv)) {
        if (value === null || value === undefined) continue;
        kv[key] = typeof value === "string"
          ? value
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
      }
      if (Object.keys(kv).length > 0) item.kv = kv;
    }
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GitHub-flavored task list rendering + grouping
// ---------------------------------------------------------------------------

/** A markdown group: a heading and the items beneath it. */
interface ItemGroup {
  heading: string;
  items: PmItem[];
}

/**
 * Group pm items for sectioned export. `status` (default) splits into Open
 * (open/in_progress/blocked/draft) and Done (closed/canceled), matching the
 * historical markdown layout. `sprint`/`type` group by that field value
 * (items missing the field land in an "(unassigned)" group, sorted last).
 */
export function groupItems(items: PmItem[], groupBy: string): ItemGroup[] {
  if (groupBy === "status") {
    const open = items.filter(
      (i) => i.status === "open" || i.status === "in_progress" || i.status === "blocked" || i.status === "draft",
    );
    const done = items.filter((i) => i.status === "closed" || i.status === "canceled");
    const groups: ItemGroup[] = [];
    if (open.length) groups.push({ heading: "Open", items: open });
    if (done.length) groups.push({ heading: "Done", items: done });
    return groups;
  }

  const key = (i: PmItem): string => {
    const v = (i as unknown as Record<string, unknown>)[groupBy];
    return v === undefined || v === null || v === "" ? "(unassigned)" : String(v);
  };
  const buckets = new Map<string, PmItem[]>();
  for (const item of items) {
    const k = key(item);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(item);
  }
  const headings = [...buckets.keys()].sort((a, b) => {
    if (a === "(unassigned)") return 1;
    if (b === "(unassigned)") return -1;
    return a.localeCompare(b);
  });
  return headings.map((h) => ({ heading: h, items: buckets.get(h)! }));
}

/**
 * Render pm items as a GitHub-flavored task list grouped into `## <heading>`
 * sections. Closed/canceled items become `- [x]`, everything else `- [ ]`.
 * A trailing `<!-- id -->` comment preserves the pm id for round-trips.
 */
export function renderTaskList(items: PmItem[], groupBy: string, metadata = false, priorityMap: PriorityMapScheme = "number"): string {
  const groups = groupItems(items, groupBy);
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`## ${group.heading}`, "");
    for (const item of group.items) {
      const check = mapPmStatusToChecked(item.status) ? "x" : " ";
      lines.push(`- [${check}] ${item.title}${metadata ? markdownMetadataSuffix(item, priorityMap) : ""} <!-- ${item.id} -->`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Render pm items as a flat checkbox markdown list: one `- [ ]`/`- [x]` line
 * per item, each carrying a `<!-- id -->` provenance comment for round-trips.
 * Unlike the default markdown export, there is no `# TODO` header and no
 * `## Open`/`## Done` (or `--group-by`) sectioning — just the checkboxes. The
 * import grammar is identical to the default `markdown` parser, so a
 * `renderCheckboxMarkdown → parseMarkdownTodos` cycle is a clean round-trip.
 */
export function renderCheckboxMarkdown(items: PmItem[], metadata = false, priorityMap: PriorityMapScheme = "number"): string {
  const lines: string[] = [];
  for (const item of items) {
    const check = mapPmStatusToChecked(item.status) ? "x" : " ";
    lines.push(`- [${check}] ${item.title}${metadata ? markdownMetadataSuffix(item, priorityMap) : ""} <!-- ${item.id} -->`);
  }
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationIssue {
  line: number;
  severity: "error" | "warning";
  message: string;
  text: string;
}

/**
 * Validate a todo file (markdown or todo.txt) and return structured issues.
 *   - errors (structural): bad date in `due:`, priority letter out of A..Z
 *   - warnings: lines that look like tasks but don't parse, empty titles
 * `format` selects the grammar; `markdown` validates checkbox lines, `todotxt`
 * validates todo.txt lines.
 */
export function validateTodoFile(
  content: string,
  format: TodoImportFormat,
): { issues: ValidationIssue[]; taskCount: number } {
  const issues: ValidationIssue[] = [];
  let taskCount = 0;
  const lines = content.split("\n");

  if (format === "todojson") {
    try {
      const details = parsePiTodoDetails(content);
      const seen = new Set<number>();
      for (const todo of details.todos) {
        taskCount++;
        if (seen.has(todo.id)) {
          issues.push({ line: 0, severity: "error", message: `Duplicate todo id '${todo.id}'`, text: String(todo.id) });
        }
        seen.add(todo.id);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push({ line: 0, severity: "error", message: msg, text: "" });
    }
    return { issues, taskCount };
  }

  if (format === "jsonl") {
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) {
          issues.push({ line: i + 1, severity: "error", message: "Line is not a JSON object", text: raw.trim() });
          continue;
        }
        const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
        if (title === "") {
          issues.push({ line: i + 1, severity: "error", message: "Missing or empty 'title'", text: raw.trim() });
          continue;
        }
        taskCount++;
        if (parsed.deadline !== undefined && typeof parsed.deadline === "string" && parsed.deadline !== "" && !isValidIsoDate(parsed.deadline.slice(0, 10))) {
          issues.push({ line: i + 1, severity: "error", message: `Invalid deadline '${parsed.deadline}' (expected YYYY-MM-DD)`, text: raw.trim() });
        }
        if (parsed.priority !== undefined && typeof parsed.priority === "number" && (parsed.priority < 0 || parsed.priority > 4 || !Number.isInteger(parsed.priority))) {
          issues.push({ line: i + 1, severity: "error", message: `Invalid priority '${parsed.priority}' (expected integer 0-4)`, text: raw.trim() });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        issues.push({ line: i + 1, severity: "error", message: `Invalid JSON: ${msg}`, text: raw.trim() });
      }
    }
    return { issues, taskCount };
  }

  if (format === "todotxt") {
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw.trim() === "") continue;
      const item = parseTodoTxtLine(raw);
      if (!item) continue;
      taskCount++;
      if (item.due !== undefined && !isValidIsoDate(item.due)) {
        issues.push({ line: i + 1, severity: "error", message: `Invalid due date '${item.due}' (expected YYYY-MM-DD)`, text: raw.trim() });
      }
      if (item.priorityLetter !== undefined && !/^[A-Z]$/.test(item.priorityLetter)) {
        issues.push({ line: i + 1, severity: "error", message: `Invalid priority '${item.priorityLetter}' (expected A-Z)`, text: raw.trim() });
      }
      if (item.text === "") {
        issues.push({ line: i + 1, severity: "warning", message: "Task has no description text", text: raw.trim() });
      }
    }
    return { issues, taskCount };
  }

  // markdown
  let sawAnyTask = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const match = TODO_RE.exec(raw);
    if (match) {
      sawAnyTask = true;
      taskCount++;
      const { text } = extractPriority(match[3].trim());
      const { text: cleanedText } = extractMarkdownDue(text);
      if (cleanedText === "") {
        issues.push({ line: i + 1, severity: "warning", message: "Checkbox has no text", text: raw.trim() });
      }
      const badDue = /(^|\s)due:(\S+)/.exec(match[3]);
      if (badDue && !isValidIsoDate(badDue[2])) {
        issues.push({ line: i + 1, severity: "error", message: `Invalid due date '${badDue[2]}' (expected YYYY-MM-DD)`, text: raw.trim() });
      }
      // The parser only honours `(p0)`..`(p4)`; a `(pN)` with N>4 is therefore
      // silently treated as literal text. Surface it as an error so the typo
      // isn't lost on import.
      const badP = /\(p(\d+)\)/i.exec(match[3]);
      if (badP && parseInt(badP[1], 10) > 4) {
        issues.push({ line: i + 1, severity: "error", message: `Priority marker (p${badP[1]}) out of range (0-4)`, text: raw.trim() });
      }
      continue;
    }
    // A line that looks like a checkbox but has a malformed marker, e.g. `- [y]`
    // or `- []`, is flagged so typos surface before import.
    if (/^\s*[-*+]\s*\[[^ xX]?\]?/.test(raw) && !match) {
      issues.push({ line: i + 1, severity: "warning", message: "Line resembles a checkbox but did not parse (check the `[ ]`/`[x]` marker)", text: raw.trim() });
    }
  }
  if (!sawAnyTask && issues.length === 0) {
    issues.push({ line: 0, severity: "warning", message: "No checkbox tasks found in file", text: "" });
  }
  return { issues, taskCount };
}

// ---------------------------------------------------------------------------
// Import preflight (fail-fast syntax gate)
//
// `pm todos import` previously read and wrote each file in turn, so a malformed
// line in (say) the second file would surface only AFTER the first file's items
// were already written to the pm store — leaving a partial import behind. To
// fail fast, every input file is validated UP FRONT, before any pm-store write,
// reusing the same `validateTodoFile` grammar the `todos validate` command uses.
//
// On any structural error in any file this throws a CommandError naming the
// problem (file + line + reason). On clean input it returns silently and the
// import proceeds. Warnings (e.g. lines that resemble checkboxes but don't
// parse) are NOT fatal — they keep the existing lenient import behaviour and are
// echoed to stderr so they remain visible.
// ---------------------------------------------------------------------------

/**
 * Validate the syntax of every file about to be imported, BEFORE touching the
 * pm store. Throws a CommandError on the first file containing structural
 * errors (or an unreadable file). Returns silently when all files are clean.
 */
export function preflightValidateImportFiles(
  files: string[],
  format: TodoImportFormat,
): void {
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const exitCode = /ENOENT|no such file/i.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
      throw new CommandError(`Preflight: cannot read ${file}: ${msg}`, exitCode);
    }

    const { issues } = validateTodoFile(content, format);
    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warning");

    // Surface warnings (non-fatal) so they stay visible even though we don't
    // abort on them — matches the lenient pre-existing import behaviour.
    for (const w of warnings) {
      const where = w.line > 0 ? `line ${w.line}` : "file";
      console.error(`  [warning] ${file}:${where}: ${w.message}` + (w.text ? `  >> ${w.text}` : ""));
    }

    if (errors.length > 0) {
      const detail = errors
        .map((e) => `  ${file}:${e.line > 0 ? `line ${e.line}` : "file"}: ${e.message}` + (e.text ? `  >> ${e.text}` : ""))
        .join("\n");
      throw new CommandError(
        `Preflight: ${errors.length} structural error(s) in ${file} — import aborted before any items were created.\n` +
          `${detail}\n` +
          `Fix the file (or run \`pm todos validate ${file}\`) and re-import.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// File discovery (glob)
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob pattern (supporting `*`, `?`, `**`) into a RegExp that
 * matches a path relative to the base directory (with `/` separators).
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**` matches across directory separators
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // swallow the trailing slash of `**/`
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * Resolve a `--glob <pattern>` into a sorted list of absolute file paths.
 * Walks the working directory (capped depth) and matches relative paths.
 */
function resolveGlob(pattern: string, cwd: string): string[] {
  const re = globToRegExp(pattern);
  const out: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
      const abs = join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, depth + 1);
      } else if (st.isFile()) {
        const rel = relative(cwd, abs).split(sep).join("/");
        if (re.test(rel)) out.push(abs);
      }
    }
  };

  walk(cwd, 0);
  return out.sort();
}

// ---------------------------------------------------------------------------
// Shared import core (used by `todos import` command + `todos` importer)
// ---------------------------------------------------------------------------

interface TodoImportOptions {
  files: string[];
  itemType: string;
  closedAs: string;
  /** Status assigned to open (unchecked) items (default: open). */
  openAs?: string;
  priority?: string;
  extraTags: string[];
  section?: string;
  /** When true, derive a tag from each item's markdown section heading. */
  sectionTags: boolean;
  dryRun: boolean;
  pmRoot: string;
  /** Source format: markdown checkboxes (default) or todo.txt. */
  format: TodoImportFormat;
  /**
   * When true, re-importing matches existing pm items and UPDATES them instead
   * of creating duplicates. Matching keys (in order): the embedded
   * `<!-- pm-id -->` comment, else a stable (title + section) signature. Default
   * false → every item is always created (historical behaviour, unchanged).
   */
  upsert?: boolean;
  /** Optional --filter status predicate; items whose mapped status differs are skipped. */
  statusFilter?: string;
  /** Optional --filter type predicate; items whose resolved type differs are skipped. */
  typeFilter?: string;
}

/**
 * Internal normalized shape a parsed line (markdown or todo.txt) is reduced to
 * before becoming a pm item. Lets the import core share one create path.
 */
interface NormalizedTodo {
  checked: boolean;
  /** Exact pm status carried by lossless formats such as jsonl. */
  status?: string;
  text: string;
  priority?: number;
  tags: string[];
  deadline?: string;
  section?: string;
  indent: number;
  lineNumber: number;
  file?: string;
  /** Source todojson id, when importing TodoDetails JSON. */
  todoId?: number;
  /** pm id parsed from a `<!-- pm-id -->` comment (markdown only); upsert key. */
  pmId?: string;
  /** Item type recovered from the exporter's ` [Type]` tag (markdown round-trip). */
  itemType?: string;
  description?: string;
  assignee?: string;
  sprint?: string;
  createdAt?: string;
  updatedAt?: string;
  creationDate?: string;
  completionDate?: string;
  kv?: Record<string, string>;
}

/**
 * Read+parse one file into normalized todos for either supported format. For
 * todo.txt, `+project`/`@context` become tags and `due:` becomes the deadline.
 */
function parseFileToNormalized(
  md: string,
  file: string | undefined,
  format: TodoImportFormat,
): NormalizedTodo[] {
  if (format === "todojson") {
    return parsePiTodoDetails(md).todos.map((item) => ({
      checked: item.done,
      text: item.text,
      tags: ["todo"],
      indent: 0,
      lineNumber: item.id,
      todoId: item.id,
      file,
    }));
  }

  if (format === "jsonl") {
    // Each line is a full PmItem JSON object; the upsert key is the carried pm
    // id (when present), making a jsonl round-trip idempotent under --upsert.
    return parseJsonl(md).map((item, i) => ({
      checked: mapPmStatusToChecked(item.status),
      status: item.status,
      text: item.title,
      priority: item.priority,
      tags: item.tags ?? [],
      deadline: item.deadline,
      indent: 0,
      lineNumber: i + 1,
      file,
      pmId: item.id || undefined,
      itemType: item.type,
      description: item.description,
      assignee: item.assignee,
      sprint: item.sprint,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      creationDate: item.creationDate,
      completionDate: item.completionDate,
      kv: item.kv,
    }));
  }

  if (format === "todotxt") {
    const lines = md.split("\n");
    const out: NormalizedTodo[] = [];
    for (let i = 0; i < lines.length; i++) {
      const item = parseTodoTxtLine(lines[i]);
      if (!item) continue;
      const tags = [...item.projects, ...item.contexts];
      out.push({
        checked: item.done,
        text: item.text,
        priority: priorityLetterToPm(item.priorityLetter),
        tags,
        deadline: item.due,
        indent: 0,
        lineNumber: i + 1,
        file,
      });
    }
    return out;
  }
  // `checkbox` shares the markdown checkbox grammar; only the export layout
  // differs (flat list, no `# TODO` header / sections), so the same parser is
  // reused for both.
  return parseMarkdownTodos(md, file).map((t) => ({
    checked: t.checked,
    text: t.text,
    priority: t.priority,
    tags: [],
    deadline: t.deadline,
    section: t.section,
    indent: t.indent,
    lineNumber: t.lineNumber,
    file: t.file,
    pmId: t.pmId,
    itemType: t.itemType,
  }));
}

/** Preserve an exact source status when available; checkbox-style formats
 * continue to map their binary checked state through --closed-as/--status. */
export function resolveImportedTodoStatus(
  sourceStatus: string | undefined,
  checked: boolean,
  closedAs: string,
  openAs = "open",
): string {
  return sourceStatus?.trim() || mapStatusToPm(checked, closedAs, openAs);
}

interface TodoImportResult {
  imported: number;
  skipped: number;
  /** Number of existing items updated in place (only meaningful with --upsert). */
  updated?: number;
  previews?: Array<Record<string, unknown>>;
  /**
   * Every source line whose pm create/update FAILED, with the file, line,
   * title, and the pm error that rejected it. A non-empty array means the
   * import was partial: the tracker now holds a subset of the file and the two
   * disagree. Callers surface this on the normal output path (the structured
   * result) and exit non-zero so a partial import is never reported as success.
   */
  dropped?: DroppedTodoLine[];
}

/**
 * A single source TODO line that did not land in the pm store. `reason` is the
 * pm error message (stripped of the surrounding recovery envelope) so the user
 * can see why the line was lost without re-running.
 */
export interface DroppedTodoLine {
  file: string;
  line: number;
  title: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Upsert support — match an incoming TODO to an existing pm item
// ---------------------------------------------------------------------------

/**
 * An existing pm item the upsert path may target. `status` is carried so the
 * update can omit `--status` when unchanged: re-sending a terminal status
 * (closed/canceled) makes `pm update` demand `--force`.
 */
export interface ExistingTodoItem {
  pmId: string;
  status?: string;
  /** The matched item's stored title — used to disambiguate a trailing type
   * bracket that is actually title content (`Complete [Task]`) from a real
   * round-trip type tag. */
  title?: string;
  /** Description is used to maintain todojson id persistence markers. */
  description?: string;
}

/**
 * Build a stable signature key for an incoming TODO from its title (and an
 * optional section). Used as the fallback upsert key when a line carries no
 * `<!-- pm-id -->` comment (e.g. a hand-written markdown file that was never
 * exported by pm-todos).
 *
 * The title is lowercased and whitespace-collapsed; the optional section is
 * slugged the same way it becomes a tag. The import path keys on the TITLE
 * ALONE (passing no section) because a stored pm item has no reliable markdown
 * section heading; the `section` parameter is retained for callers that do have
 * a trustworthy section to disambiguate on. Returns undefined for an empty
 * title (nothing stable to key on).
 */
export function todoSignatureKey(title: string, section?: string): string | undefined {
  const t = title.toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const s = section ? sectionToTag(section) : "";
  return `${s}\u001f${t}`;
}

/**
 * Build the two lookup indexes an `--upsert` import needs from the current
 * workspace items:
 *   - byId:  pm id  → existing item (exact match on the embedded comment id)
 *   - bySig: (title+section) signature → existing item (fallback match)
 *
 * For the signature index, first write wins so the oldest matching item is the
 * stable upsert target (mirrors pm-beads' "oldest wins" rule). The id index is
 * keyed on the item's own `id`, which is exactly what the exporter embeds.
 */
export function buildExistingTodoIndex(items: PmItem[]): {
  byId: Map<string, ExistingTodoItem>;
  bySig: Map<string, ExistingTodoItem>;
} {
  const byId = new Map<string, ExistingTodoItem>();
  const bySig = new Map<string, ExistingTodoItem>();
  for (const item of items) {
    if (!item.id) continue;
    const entry: ExistingTodoItem = {
      pmId: item.id,
      status: item.status,
      title: item.title,
      description: item.description,
    };
    byId.set(item.id, entry);
    // The exported section heading is the pm status group (Open/Done) or a
    // sprint/type value; a hand-edited file usually keeps the original heading.
    // We index by title alone AND by every plausible section so the fallback
    // tolerates a missing/renamed heading on the incoming side.
    const sigNoSection = todoSignatureKey(item.title ?? "");
    if (sigNoSection && !bySig.has(sigNoSection)) bySig.set(sigNoSection, entry);
  }
  return { byId, bySig };
}

/** Pull the created item id out of `pm --json create` output (shape varies). */
export function extractCreatedTodoId(stdout: string): string | undefined {
  try {
    const j = JSON.parse(stdout);
    return j?.id || j?.item?.id || j?.result?.id;
  } catch {
    return undefined;
  }
}

// Node's spawnSync defaults to a 1 MiB stdout cap, which a mature tracker's JSON
// dump passes at a few hundred items. Past that the child is killed with ENOBUFS,
// status null and EMPTY stderr, so the failure surfaces with nothing to diagnose
// (and at larger sizes stdout is genuinely truncated mid-document).
// 64 MiB matches the cap the sibling pm packages settled on.
/** Read-buffer cap for `pm` output, in bytes. 64 MiB by default; override with the
 * `PM_JSON_MAX_BUFFER` env var. Resolved per call so the override takes effect
 * without an import-order dependency. Invalid or non-positive values fall back to
 * the default rather than silently disabling the guard. */
function pmJsonMaxBuffer(): number {
  // Number(), not parseInt(): parseInt("64MiB") silently yields 64, which would
  // impose a 64-BYTE cap and break every ordinary read while appearing to honor
  // the documented invalid-value fallback. Number() rejects the whole string.
  const raw = Number(process.env.PM_JSON_MAX_BUFFER);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 64 * 1024 * 1024;
}

/** Name the real cause of a failed `pm` read. A stdout overrun kills the child
 * with `status: null` and EMPTY stderr, so without this the failure surfaces as
 * an unexplained error (or, worse, as an empty result set). */
function describePmReadFailure(error: Error, limitBytes: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOBUFS") {
    return `pm output exceeded the ${limitBytes} byte read buffer. `
      + "The workspace is larger than this integration's read limit; narrow the "
      + "operation or raise PM_JSON_MAX_BUFFER.";
  }
  return `pm read failed: ${error.message}`;
}

/**
 * Run the host-owned pm CLI without routing workspace arguments through a shell.
 *
 * POSIX hosts can resolve the executable shim directly through `PATH`. Windows
 * cannot execute npm `.cmd` shims through shell-free `spawnSync`, so the pm host
 * publishes its package root and this runner validates the declared `bin.pm`
 * entry before invoking it with the current Node executable.
 */
function runPmCommand(args: string[], maxBuffer = 64 * 1024 * 1024): SpawnSyncReturns<string> {
  let command = "pm";
  let commandArgs = args;
  if (process.platform === "win32") {
    const configuredRoot = process.env.PM_CLI_PACKAGE_ROOT;
    if (typeof configuredRoot !== "string" || configuredRoot.trim() === "") {
      throw new CommandError("The pm host did not publish PM_CLI_PACKAGE_ROOT for a secure Windows CLI relaunch.");
    }
    const packageRoot = resolve(configuredRoot.trim());
    let packageMetadata: unknown;
    try {
      packageMetadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    } catch {
      throw new CommandError("Could not read the installed pm CLI package metadata.");
    }
    const bin = isRecord(packageMetadata) && isRecord(packageMetadata.bin) ? packageMetadata.bin.pm : undefined;
    if (typeof bin !== "string" || bin.trim() === "") {
      throw new CommandError("The installed pm CLI package does not declare its pm executable.");
    }
    const cliEntry = resolve(packageRoot, bin);
    const relativeEntry = relative(packageRoot, cliEntry);
    if (relativeEntry.startsWith("..") || isAbsolute(relativeEntry)) {
      throw new CommandError("The installed pm CLI package declares an executable outside its package root.");
    }
    command = process.execPath;
    commandArgs = [cliEntry, ...args];
  }
  return spawnSync(command, commandArgs, { encoding: "utf8", maxBuffer });
}

/** Render an untrusted receipt value while preserving missing evidence. */
function describeReceiptValue(value: unknown): string {
  return value === undefined ? "<missing>" : String(JSON.stringify(value));
}

/** Receipt contracts whose completeness semantics this reader has verified. */
const SUPPORTED_READ_OUTPUT_CONTRACT_VERSIONS: ReadonlySet<number> = new Set([1]);

/** Canonical whole-corpus arguments shared by both TODO read consumers. */
export const COMPLETE_LIST_COMMAND_ARGUMENTS = [
  "list", "--all", "--json", "--include-body", "--strict-read", "--no-truncate",
  "--output-budget", "unbounded", "--output-limit", "unbounded", "--output-include", "full",
] as const;

/** Collect the pm 2026.8.21 receipt gaps not yet rejected by the public SDK. */
function supplementalCompleteListFindings(record: Record<string, unknown>): string[] {
  const findings: string[] = [];
  const completeness = isRecord(record.completeness) ? record.completeness : undefined;
  for (const field of ["unreadable_item_count", "unreadable_directory_count"] as const) {
    if (completeness?.[field] !== 0) findings.push(`completeness.${field}=${describeReceiptValue(completeness?.[field])}`);
  }
  const omission = isRecord(record.omission_receipt) ? record.omission_receipt : undefined;
  if (omission === undefined) {
    findings.push("omission_receipt=<missing>");
  } else {
    if (omission.has_omissions !== false) findings.push(`omission_receipt.has_omissions=${describeReceiptValue(omission.has_omissions)}`);
    if (!Number.isSafeInteger(omission.omitted_field_group_count) || omission.omitted_field_group_count !== 0) {
      findings.push(`omission_receipt.omitted_field_group_count=${describeReceiptValue(omission.omitted_field_group_count)}`);
    }
    if (!Array.isArray(omission.omitted_field_groups) || omission.omitted_field_groups.length !== 0) {
      findings.push(`omission_receipt.omitted_field_groups=${describeReceiptValue(omission.omitted_field_groups)}`);
    }
  }
  const rawReadOutput = record.read_output;
  const readOutput = isRecord(rawReadOutput) ? rawReadOutput : undefined;
  if (readOutput === undefined) {
    findings.push(`read_output=${describeReceiptValue(rawReadOutput)}`);
  } else {
    for (const [field, expected] of [
      ["command", "list"], ["within_budget", true], ["strings_compacted", false],
      ["rows_compacted", false], ["result_omitted", false],
    ] as const) {
      if (readOutput[field] !== expected) findings.push(`read_output.${field}=${describeReceiptValue(readOutput[field])}`);
    }
    const contractVersion = readOutput.contract_version;
    if (typeof contractVersion !== "number" || !SUPPORTED_READ_OUTPUT_CONTRACT_VERSIONS.has(contractVersion)) {
      findings.push(`read_output.contract_version=${describeReceiptValue(contractVersion)}`);
    }
    const dimensions = readOutput.requested_dimensions;
    if (!Array.isArray(dimensions)) {
      findings.push(`read_output.requested_dimensions=${describeReceiptValue(dimensions)}`);
    } else {
      for (const dimension of ["include", "amount", "cost"] as const) {
        if (!dimensions.includes(dimension)) findings.push(`read_output.requested_dimensions missing ${dimension}`);
      }
    }
  }
  if (record.output_budget_truncation !== undefined) findings.push("output_budget_truncation=<present>");
  if (record.output_budget_exceeded !== undefined) findings.push("output_budget_exceeded=<present>");
  return findings;
}

/** Decode only a complete, unbounded `pm list --all` envelope. */
export function readItemsFromListAll(parsed: unknown, usedFor = "the TODO operation"): PmItem[] {
  const record = isRecord(parsed) ? parsed : undefined;
  const sdkFindings = inspectCompleteListResult(parsed).findings.map((finding) => `${finding.code}: ${finding.message}`);
  const findings = record === undefined ? sdkFindings : [...sdkFindings, ...supplementalCompleteListFindings(record)];
  if (record === undefined || findings.length > 0) {
    const count = record && typeof record.count === "number" ? record.count : "unknown";
    const total = record && typeof record.total === "number" ? record.total : "unknown";
    throw new CommandError(
      `pm list --all complete-corpus answer was refused for ${usedFor}: ${findings.join("; ")}; `
      + `count=${count} of total=${total}. A partial tracker read could create duplicates or omit exported tasks.`,
    );
  }
  const rows: PmItem[] = [];
  for (const item of certifyCompleteListResult(record).items) {
    if (typeof item.title !== "string" || typeof item.status !== "string") {
      throw new CommandError(`Refusing unverifiable pm list --all output: item ${item.id} needs string title and status.`);
    }
    const row: PmItem = { id: item.id, title: item.title, status: item.status };
    for (const field of ["description", "type", "deadline", "assignee", "sprint", "created_at", "updated_at", "todos_creation_date", "todos_completion_date", "todos_source_created_at", "todos_source_updated_at"] as const) {
      if (item[field] !== undefined && typeof item[field] !== "string") {
        throw new CommandError(`Refusing unverifiable pm list --all output: item ${item.id} field ${field} must be a string when present.`);
      }
      if (typeof item[field] === "string") row[field] = item[field];
    }
    if (item.priority !== undefined && typeof item.priority !== "number") {
      throw new CommandError(`Refusing unverifiable pm list --all output: item ${item.id} priority must be a number when present.`);
    }
    if (typeof item.priority === "number") row.priority = item.priority;
    if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string"))) {
      throw new CommandError(`Refusing unverifiable pm list --all output: item ${item.id} tags must be strings when present.`);
    }
    if (Array.isArray(item.tags)) row.tags = item.tags as string[];
    for (const field of ["todos_kv", "kv"] as const) {
      if (item[field] !== undefined && (!isRecord(item[field]) || Object.values(item[field]).some((value) => typeof value !== "string"))) {
        throw new CommandError(`Refusing unverifiable pm list --all output: item ${item.id} field ${field} must contain string values.`);
      }
      if (isRecord(item[field])) row[field] = item[field] as Record<string, string>;
    }
    rows.push(row);
  }
  return rows;
}

/** Backward-compatible assertion backed by the canonical SDK certifier. */
export function assertListAllComplete(envelope: unknown, usedFor: string): void {
  readItemsFromListAll(envelope, usedFor);
}

/** Fetch current workspace items for either upsert indexing or TODO export. */
function readCompletePmItems(pmRoot: string, usedFor: string): PmItem[] {
  const maxBuffer = pmJsonMaxBuffer();
  const result = runPmCommand(["--pm-path", pmRoot, ...COMPLETE_LIST_COMMAND_ARGUMENTS], maxBuffer);
  if (result.error) {
    throw new CommandError(describePmReadFailure(result.error, maxBuffer));
  }
  if (result.status !== 0) {
    throw new CommandError(result.stderr || `pm list --all failed (needed for ${usedFor})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new CommandError(`Could not parse \`pm list --all --json\` output (needed for ${usedFor}).`);
  }
  // Deliberately OUTSIDE the parse try/catch. Inside it, the CommandError this
  // throws was caught by that bare `catch` and replaced with "Could not parse",
  // so an incomplete-envelope refusal surfaced as a parse error and the operator
  // lost the signal naming and the count-versus-total scale — the diagnostic
  // this gate exists to produce.
  return readItemsFromListAll(parsed, usedFor);
}

/**
 * Convert JSONL-only metadata into namespaced extension fields. pm owns its
 * audit timestamps and reserved `kv` slot, so imports must not overwrite those
 * internals. Namespaced fields preserve the source payload losslessly and the
 * JSONL serializer maps them back to the public JSONL keys on export.
 */
export function buildJsonlImportFieldArgs(todo: Pick<NormalizedTodo,
  "kv" | "creationDate" | "completionDate" | "createdAt" | "updatedAt"
>): string[] {
  const fields: Array<[string, string | Record<string, string> | undefined]> = [
    ["todos_kv", todo.kv],
    ["todos_creation_date", todo.creationDate],
    ["todos_completion_date", todo.completionDate],
    ["todos_source_created_at", todo.createdAt],
    ["todos_source_updated_at", todo.updatedAt],
  ];
  const args: string[] = [];
  for (const [name, value] of fields) {
    if (value === undefined || (typeof value === "string" && value.trim() === "")) continue;
    args.push("--field", `${name}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return args;
}

/**
 * Read, parse and (unless dry-run) create pm items for every TODO found across
 * the given files. Single code path shared by the command and the importer.
 */
function runTodoImport(opts: TodoImportOptions): TodoImportResult {
  let imported = 0;
  let skipped = 0;
  let updated = 0;
  const previews: Array<Record<string, unknown>> = [];
  // Every source line whose pm create/update failed. A non-empty array is the
  // signal that the import was partial and the tracker/file now disagree; the
  // caller turns it into a non-zero exit and a structured report so the loss is
  // never silent. (With the close-reason fix below, the normal completed-line
  // path no longer fails, so this stays empty on the common case.)
  const dropped: DroppedTodoLine[] = [];

  // With --upsert, build the lookup indexes once up front (also in dry-run so
  // the preview reports create vs. update accurately). Without --upsert these
  // stay empty and every item is created — the unchanged historical behaviour.
  const index = opts.upsert
    ? buildExistingTodoIndex(readCompletePmItems(opts.pmRoot, "the --upsert key index"))
    : { byId: new Map<string, ExistingTodoItem>(), bySig: new Map<string, ExistingTodoItem>() };

  // Resolve an incoming TODO to an existing item: prefer the embedded pm-id
  // comment (exact), then fall back to the title signature. A stored pm item
  // carries no reliable markdown section heading (the section becomes a
  // case-folded tag), so the fallback keys on the title alone — matching how
  // `buildExistingTodoIndex` builds `bySig`.
  const resolveExisting = (todo: NormalizedTodo): ExistingTodoItem | undefined => {
    if (!opts.upsert) return undefined;
    if (todo.pmId && index.byId.has(todo.pmId)) return index.byId.get(todo.pmId);
    const sig = todoSignatureKey(todo.text);
    if (sig && index.bySig.has(sig)) return index.bySig.get(sig);
    return undefined;
  };

  for (const file of opts.files) {
    let md: string;
    try {
      md = readFileSync(file, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const exitCode = /ENOENT|no such file/i.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
      throw new CommandError(`Failed to read file ${file}: ${msg}`, exitCode);
    }

    let todos = parseFileToNormalized(md, file, opts.format);
    if (opts.section && opts.format === "markdown") {
      const want = opts.section.trim().toLowerCase();
      todos = todos.filter((t) => (t.section ?? "").toLowerCase() === want);
    }
    // Apply --filter status/type predicates (after parsing, before creating).
    // Status is the mapped pm status; type is the per-item type (round-trip tag)
    // or the import-wide --type default — the same values that get written.
    if (opts.statusFilter || opts.typeFilter) {
      todos = todos.filter((t) => {
        const status = resolveImportedTodoStatus(t.status, t.checked, opts.closedAs, opts.openAs ?? "open");
        if (opts.statusFilter && status !== opts.statusFilter) return false;
        if (opts.typeFilter) {
          const resolvedType = t.itemType ?? opts.itemType;
          if (resolvedType !== opts.typeFilter) return false;
        }
        return true;
      });
    }

    for (const todo of todos) {
      const tags = [...opts.extraTags];
      // Per-item tags (todo.txt +project/@context) carry through.
      for (const t of todo.tags) {
        if (t && !tags.includes(t)) tags.push(t);
      }
      if (opts.sectionTags && todo.section) {
        const tag = sectionToTag(todo.section);
        if (tag && !tags.includes(tag)) tags.push(tag);
      }

      // CLI --priority wins; otherwise use the priority inferred from markers.
      const priority =
        opts.priority !== undefined && opts.priority !== ""
          ? opts.priority
          : todo.priority !== undefined
            ? String(todo.priority)
            : undefined;

      const status = resolveImportedTodoStatus(todo.status, todo.checked, opts.closedAs, opts.openAs ?? "open");

      // Prefer the per-item type recovered from the round-trip ` [Type]` tag;
      // fall back to the import-wide `--type` (default "Task") for lines that
      // carry no provenance tag (hand-written todos).
      const itemType = todo.itemType ?? opts.itemType;

      const existing = resolveExisting(todo);

      if (opts.dryRun) {
        const action = existing ? "update" : "create";
        previews.push({
          action,
          existingId: existing?.pmId,
          todoId: todo.todoId,
          checked: todo.checked,
          title: todo.text,
          status,
          priority,
          tags,
          deadline: todo.deadline,
          section: todo.section,
          indent: todo.indent,
          file: todo.file,
          line: todo.lineNumber,
        });
        console.error(
          `  [dry-run] ${action}${existing ? ` ${existing.pmId}` : ""} ${todo.checked ? "[x]" : "[ ]"} ${"  ".repeat(Math.floor(todo.indent / 2))}${todo.text}` +
            (tags.length ? ` (tags: ${tags.join(",")})` : "") +
            (priority !== undefined ? ` (p${priority})` : "") +
            (todo.deadline ? ` (due: ${todo.deadline})` : ""),
        );
        if (action === "update") updated++;
        else imported++;
        continue;
      }

      try {
        if (existing) {
          // UPSERT: update the matched item in place rather than duplicating.
          // Disambiguate a trailing bracket that is actually TITLE CONTENT from
          // a real round-trip type tag, using the matched item's stored title.
          const { title: updTitle, type: updType } = resolveUpsertTitleType(
            todo.text,
            todo.itemType,
            existing.title,
          );
          const updArgs = [
            "--path", opts.pmRoot,
            "--json",
            "update", existing.pmId,
            "--title", updTitle,
          ];
          // Only set the type when the line carried a round-trip `[Type]` tag.
          // A tagless line — a closed item (the exporter omits its tag), a
          // grouped-export line, or a hand-written entry — must NOT retype a
          // matched item: we deliberately do NOT apply the import-wide `--type`
          // here, since an upsert should never silently bulk-retype existing
          // items that simply lacked a per-item tag. The matched item keeps its
          // current type untouched.
          if (updType) updArgs.push("--type", updType);
          // Only set status when it actually changes. Re-sending a terminal
          // status (closed/canceled) makes `pm update` require --force; omitting
          // it keeps re-import idempotent without forcing a spurious re-close.
          if (status !== existing.status) {
            updArgs.push("--status", status);
            // pm refuses to transition an item into a terminal status without a
            // close reason when require_close_reason is on (the default). Supply
            // the traceable source provenance so an upsert that closes an item
            // is not rejected — which would otherwise drop the line.
            if (isTerminalStatus(status)) {
              updArgs.push("--close-reason", buildImportCloseReason(status, todo.file, todo.lineNumber));
            }
          }
          if (priority !== undefined && priority !== "") updArgs.push("--priority", priority);
          if (tags.length > 0) updArgs.push("--tags", tags.join(",")); // --tags replaces
          if (todo.deadline) updArgs.push("--deadline", todo.deadline);
          if (opts.format === "jsonl") {
            if (todo.description !== undefined) updArgs.push("--description", todo.description);
            if (todo.assignee) updArgs.push("--assignee", todo.assignee);
            if (todo.sprint) updArgs.push("--sprint", todo.sprint);
            updArgs.push(...buildJsonlImportFieldArgs(todo));
          }
          const todojsonTodoId = opts.format === "todojson" ? todo.todoId : undefined;
          const todojsonDescription = todojsonTodoId !== undefined
            ? buildTodojsonImportDescription(todo.file, todo.lineNumber, todojsonTodoId)
            : undefined;
          if (todojsonTodoId !== undefined && shouldRefreshTodojsonDescription(existing.description, todojsonTodoId)) {
            updArgs.push("--description", todojsonDescription as string);
          }

          const result = runPmCommand(updArgs);
          if (result.status !== 0) {
            throw new Error(result.stderr || "pm update failed");
          }
          existing.status = status;
          existing.title = updTitle;
          if (todojsonDescription) existing.description = todojsonDescription;
          updated++;
        } else {
          const isTodojson = opts.format === "todojson" && todo.todoId !== undefined;
          const importDescription = buildTodojsonImportDescription(
            todo.file,
            todo.lineNumber,
            isTodojson ? todo.todoId : undefined,
          );
          const spawnArgs = [
            "--path", opts.pmRoot,
            ...(opts.upsert ? ["--json"] : []),
            "create",
            "--title", todo.text,
            "--type", itemType,
            "--status", status,
            "--description", opts.format === "jsonl" ? (todo.description ?? "") : importDescription,
          ];
          if (opts.format === "jsonl" && todo.pmId) spawnArgs.push("--id", todo.pmId);
          // pm refuses to create an item directly in a terminal status
          // (closed/canceled) without a close reason when
          // `governance.require_close_reason` is enabled — and that policy is a
          // built-in default, not something a fresh workspace opts into. Without
          // a reason here, every checked `[x]` line is rejected on the normal
          // out-of-the-box path and the importer silently drops it. The source
          // file and line are already known at this call site, so attach them as
          // the immutable closure evidence: a traceable reason a user can tie
          // back to the originating TODO file.
          if (isTerminalStatus(status)) {
            spawnArgs.push("--close-reason", buildImportCloseReason(status, todo.file, todo.lineNumber));
          }
          if (priority !== undefined && priority !== "") spawnArgs.push("--priority", priority);
          if (tags.length > 0) spawnArgs.push("--tags", tags.join(","));
          if (todo.deadline) spawnArgs.push("--deadline", todo.deadline);
          if (opts.format === "jsonl") {
            if (todo.assignee) spawnArgs.push("--assignee", todo.assignee);
            if (todo.sprint) spawnArgs.push("--sprint", todo.sprint);
            spawnArgs.push(...buildJsonlImportFieldArgs(todo));
          }

          const result = runPmCommand(spawnArgs);
          if (result.status !== 0) {
            throw new Error(result.stderr || "pm create failed");
          }
          imported++;

          // Under --upsert, record the just-created item in both indexes so a
          // later line in the SAME run (or file) that repeats it upserts onto
          // this item instead of creating yet another duplicate.
          if (opts.upsert) {
            const createdId = extractCreatedTodoId(result.stdout);
            if (createdId) {
              const entry: ExistingTodoItem = {
                pmId: createdId,
                status,
                title: todo.text,
                description: importDescription,
              };
              index.byId.set(createdId, entry);
              const sig = todoSignatureKey(todo.text);
              if (sig && !index.bySig.has(sig)) index.bySig.set(sig, entry);
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${todo.file}:${todo.lineNumber}: ${existing ? "update" : "create"} failed — ${msg}`);
        // Record the loss in the structured result so it reaches the normal
        // output path (stdout), not only the stderr line above. `skipped` stays
        // as the historical count; `dropped` is the per-line report a caller or
        // script can inspect to see exactly which finished work vanished.
        dropped.push({ file: todo.file ?? "stdin", line: todo.lineNumber, title: todo.text, reason: msg });
        skipped++;
      }
    }
  }

  return { imported, skipped, updated, dropped, previews: opts.dryRun ? previews : undefined };
}

// ---------------------------------------------------------------------------
// Shared export core (used by `todos export` command + `todos` exporter)
// ---------------------------------------------------------------------------

interface TodoExportOptions {
  statusFilter?: string;
  typeFilter?: string;
  pmRoot: string;
  /** Output format: markdown (default), todotxt, tasklist, todojson, jsonl, or checkbox. */
  format?: TodoExportFormat;
  /** Section grouping for markdown/tasklist: status (default) | sprint | type. */
  groupBy?: string;
  /** Optional ordering applied after filtering: priority | deadline | title. */
  sort?: "priority" | "deadline" | "title";
  /** Include parseable priority/deadline tokens in markdown/tasklist output. */
  metadata?: boolean;
  /** Priority-rendering scheme for markdown/tasklist metadata tokens. */
  priorityMap?: PriorityMapScheme;
  /** Reverse the final item order. With --sort this produces descending order;
   * without --sort it reverses pm's native list order. */
  reverse?: boolean;
}

/**
 * Apply the export `--sort` and `--reverse` ordering to a list of pm items.
 * Pure: returns a new array, never mutates the input. `--sort` orders ascending
 * (priority 0 first, earliest deadline first, alphabetical title); `--reverse`
 * then flips the order. The two flags compose: `--sort priority --reverse`
 * yields lowest-priority first. Without a sort key, reverse simply flips pm's
 * native `list-all` order. The input array is never returned or mutated.
 */
export function applyExportOrder(
  items: PmItem[],
  sort: "priority" | "deadline" | "title" | undefined,
  reverse: boolean | undefined,
): PmItem[] {
  const out = sort ? sortItems(items, sort) : [...items];
  if (reverse) out.reverse();
  return out;
}

/** Fetch + filter proven-complete pm items via canonical `pm list --all`. */
function fetchPmItems(opts: TodoExportOptions): PmItem[] {
  let items = readCompletePmItems(opts.pmRoot, "the TODO export");
  if (opts.statusFilter) items = items.filter((i) => i.status === opts.statusFilter);
  if (opts.typeFilter) items = items.filter((i) => i.type === opts.typeFilter);
  return applyExportOrder(items, opts.sort, opts.reverse);
}

/**
 * Render the default-markdown TODO export. Kept byte-identical to the original
 * (the `# TODO` header, export-timestamp comment, `## Open`/`## Done` sections,
 * and the `[type]` annotation on open items) so existing behaviour is stable.
 * This is the path used when no `--group-by` (or `--group-by status`) is set.
 */
export function renderDefaultMarkdown(items: PmItem[], nowIso: string, metadata = false, priorityMap: PriorityMapScheme = "number"): string {
  const lines: string[] = [
    "# TODO",
    "",
    `<!-- Exported from pm-cli on ${nowIso} -->`,
    "",
  ];

  const openItems = items.filter(
    (i) => i.status === "open" || i.status === "in_progress" || i.status === "blocked" || i.status === "draft",
  );
  const closedItems = items.filter((i) => i.status === "closed" || i.status === "canceled");

  if (openItems.length > 0) {
    lines.push("## Open", "");
    for (const item of openItems) {
      const check = mapPmStatusToChecked(item.status) ? "x" : " ";
      const meta = metadata ? markdownMetadataSuffix(item, priorityMap) : "";
      const typeTag = item.type ? ` [${item.type}]` : "";
      lines.push(`- [${check}] ${item.title}${meta}${typeTag} <!-- ${item.id} -->`);
    }
    lines.push("");
  }

  if (closedItems.length > 0) {
    lines.push("## Done", "");
    for (const item of closedItems) {
      lines.push(`- [x] ${item.title}${metadata ? markdownMetadataSuffix(item, priorityMap) : ""} <!-- ${item.id} -->`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render grouped markdown for `--group-by sprint|type` (or an explicit
 * `--group-by status`). Each group is a `## <heading>` section of checkboxes
 * carrying the pm id comment for round-trips.
 */
export function renderGroupedMarkdown(items: PmItem[], groupBy: string, nowIso: string, metadata = false, priorityMap: PriorityMapScheme = "number"): string {
  const lines: string[] = [
    "# TODO",
    "",
    `<!-- Exported from pm-cli on ${nowIso} -->`,
    "",
  ];
  for (const group of groupItems(items, groupBy)) {
    lines.push(`## ${group.heading}`, "");
    for (const item of group.items) {
      const check = mapPmStatusToChecked(item.status) ? "x" : " ";
      lines.push(`- [${check}] ${item.title}${metadata ? markdownMetadataSuffix(item, priorityMap) : ""} <!-- ${item.id} -->`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Build export output for any supported format. Returns `count: 0` (empty
 * string) when there are no items, matching the original contract.
 */
function buildTodoMarkdown(opts: TodoExportOptions): { markdown: string; count: number } {
  const items = fetchPmItems(opts);
  if (items.length === 0) return { markdown: "", count: 0 };

  const format = opts.format ?? "markdown";
  const groupBy = opts.groupBy;
  const priorityMap = opts.priorityMap ?? "number";

  if (format === "todotxt") {
    return { markdown: serializeTodoTxt(items), count: items.length };
  }
  if (format === "todojson") {
    return { markdown: serializePiTodoDetails(items), count: items.length };
  }
  if (format === "jsonl") {
    return { markdown: serializeJsonl(items), count: items.length };
  }
  if (format === "checkbox") {
    return { markdown: renderCheckboxMarkdown(items, opts.metadata, priorityMap), count: items.length };
  }
  if (format === "tasklist") {
    return { markdown: renderTaskList(items, groupBy ?? "status", opts.metadata, priorityMap), count: items.length };
  }
  // markdown
  if (groupBy && groupBy !== "status") {
    return { markdown: renderGroupedMarkdown(items, groupBy, new Date().toISOString(), opts.metadata, priorityMap), count: items.length };
  }
  return { markdown: renderDefaultMarkdown(items, new Date().toISOString(), opts.metadata, priorityMap), count: items.length };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Local stand-in for the SDK's `defineExtension` identity helper.
 *
 * Declared here rather than imported so this package keeps a type-only
 * dependency on `@unbrained/pm-cli` and adds no runtime module edge. The
 * generic constraint is the SDK's own, so the extension object is contract-
 * checked against {@link ExtensionModule} exactly as the imported helper would.
 */
const defineExtension = <TModule extends ExtensionModule>(module: TModule): TModule => module;

export default defineExtension({
  name: "pm-todos",
  version: "2026.9.1",

  activate(api: ExtensionApi) {
    api.registerItemFields([
      { name: "todos_kv", type: "object", optional: true },
      { name: "todos_creation_date", type: "string", optional: true },
      { name: "todos_completion_date", type: "string", optional: true },
      { name: "todos_source_created_at", type: "string", optional: true },
      { name: "todos_source_updated_at", type: "string", optional: true },
    ]);

    // -----------------------------------------------------------------------
    // Command: pm todos validate <file>
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "todos validate",
      description:
        "Parse a TODO file and report problems (unparseable checkbox lines, " +
        "out-of-range priorities, malformed due dates) WITHOUT importing. " +
        "Exits non-zero when structural errors are found.",
      intent: "validate a markdown or todo.txt TODO file without importing",
      examples: [
        "pm todos validate TODO.md",
        "pm todos validate todo.txt --format todotxt",
        "pm todos validate todo-state.json --format todojson",
        "pm todos validate backlog.jsonl --format jsonl",
        "pm todos validate TODO.md --format checkbox --json",
        "pm todos validate TODO.md --json",
      ],
      flags: [
        { long: "--format", value_name: "fmt", description: "File format: markdown (default) | todotxt | todojson | jsonl | checkbox" },
        // `--json` is a host-owned global flag: do not redeclare it (the host
        // rejects the registration); read it from ctx.global instead.
      ],
      async run(ctx: CommandHandlerContext) {
        const format = readImportFormat(ctx.options);
        // `--json` is a host-owned global flag; read it from ctx.global.
        const asJson = ctx.global?.json === true;
        const filePath = ctx.args[0] as string | undefined;
        if (!filePath) {
          throw new CommandError(
            "Usage: pm todos validate <file> [--format markdown|todotxt|todojson|jsonl|checkbox] [--json]",
            EXIT_CODE.USAGE,
          );
        }

        let content: string;
        try {
          content = readFileSync(resolve(filePath), "utf-8");
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const exitCode = /ENOENT|no such file/i.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
          throw new CommandError(`Failed to read file ${filePath}: ${msg}`, exitCode);
        }

        const { issues, taskCount } = validateTodoFile(content, format);
        const errors = issues.filter((i) => i.severity === "error");
        const warnings = issues.filter((i) => i.severity === "warning");

        // Always echo a human-readable summary to stderr (stderr survives a
        // throw, unlike stdout, so this stays visible even when we exit non-zero
        // on structural errors). Under --json the full report — including the
        // structured `issues` array — is returned and rendered by the runtime as
        // JSON on stdout; for the error case the non-zero exit + this stderr
        // summary signal invalidity (the runtime discards a throwing handler's
        // stdout, so we deliberately do not duplicate JSON there).
        for (const issue of issues) {
          const where = issue.line > 0 ? `line ${issue.line}` : "file";
          console.error(`  [${issue.severity}] ${where}: ${issue.message}` + (issue.text ? `  >> ${issue.text}` : ""));
        }
        console.error(`Validated ${taskCount} task(s): ${errors.length} error(s), ${warnings.length} warning(s).`);

        if (errors.length > 0) {
          throw new CommandError(`${errors.length} structural error(s) found in ${filePath}`, EXIT_CODE.GENERIC_FAILURE);
        }
        const report = { file: resolve(filePath), format, taskCount, errors: errors.length, warnings: warnings.length };
        return asJson ? { ...report, issues } : report;
      },
    });

    // -----------------------------------------------------------------------
    // Command: pm todos context
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "todos context",
      description:
        "Return a compact TODO workspace context snapshot (counts + focused " +
        "items) optimized for agent prompts and low-token handoffs.",
      intent: "summarize actionable TODO context for agents without exporting full files",
      examples: [
        "pm todos context",
        "pm todos context --status open --sort priority",
        "pm todos context --type Task --limit 10",
        "pm todos context --include-tags",
      ],
      flags: [
        { long: "--status", value_name: "status", description: "Filter items by status before summarizing" },
        { long: "--type", value_name: "type", description: "Filter items by type before summarizing" },
        { long: "--sort", value_name: "key", description: "Focus order: priority | deadline | title (default: triage)" },
        { long: "--limit", value_name: "n", description: "Max focus rows in output (1-200, default: 20)" },
        { long: "--include-tags", description: "Include tags on focus rows (off by default for token efficiency)" },
      ],
      async run(ctx: CommandHandlerContext) {
        const statusFilter = readStringOption(ctx.options, "status");
        const typeFilter = readStringOption(ctx.options, "type");
        const sort = readSort(ctx.options);
        const limit = readBoundedIntOption(ctx.options, {
          key: "limit",
          label: "--limit",
          min: 1,
          max: 200,
          defaultValue: 20,
        });
        const includeTags = readBoolOption(ctx.options, "include-tags", "includeTags");

        const items = fetchPmItems({
          statusFilter,
          typeFilter,
          pmRoot: ctx.pm_root,
          sort,
        });
        const snapshot = buildTodoContextSnapshot(items, {
          limit,
          sort,
          includeTags,
          statusFilter,
          typeFilter,
        });
        console.error(`Context snapshot: ${snapshot.totalMatched} matched item(s), ${snapshot.focusCount} focus row(s).`);
        return snapshot;
      },
    });

    // -----------------------------------------------------------------------
    // Command: pm todos sync <file>
    //
    // Bidirectional reconciliation: import file changes into the pm store
    // (upserting onto existing items so re-syncing does not duplicate), then
    // write a fresh export of the reconciled pm state back to the SAME file so
    // pm-side changes (ids, statuses, priorities, deadlines) flow back. The
    // net effect is that file and pm store converge to the same state.
    //
    // Sync always upserts (the import half is meaningless without it). It
    // supports every round-trippable format (markdown, todotxt, todojson,
    // jsonl, checkbox). `tasklist` is export-only and rejected.
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "todos sync",
      description:
        "Bidirectionally sync a TODO file with the pm store: import file " +
        "changes (upsert, no duplicates) and write the reconciled pm state " +
        "back to the file so ids/statuses round-trip.",
      intent: "bidirectionally sync a markdown/todo.txt/todojson/jsonl/checkbox file with pm items",
      examples: [
        "pm todos sync TODO.md",
        "pm todos sync todo.txt --format todotxt",
        "pm todos sync todo-state.json --format todojson",
        "pm todos sync backlog.jsonl --format jsonl --filter status=open",
        "pm todos sync TODO.md --format checkbox --metadata --priority-map letter",
      ],
      arguments: [
        { name: "file", required: false, description: "Path to the TODO file to sync (or use --file)" },
      ],
      flags: [
        { long: "--file", value_name: "path", description: "Path to the TODO file (alternative to the positional argument)" },
        { long: "--format", value_name: "fmt", description: "File format: markdown (default), todotxt, todojson, jsonl, or checkbox" },
        { long: "--type", value_name: "type", description: "Item type for newly created items (default: Task)" },
        { long: "--closed-as", value_name: "status", description: "Status for checked items (default: closed)" },
        { long: "--status", value_name: "status", description: "Status for open/unchecked items (default: open)" },
        { long: "--priority", value_name: "n", description: "Priority 0-4; overrides markers inferred from text" },
        { long: "--tags", value_name: "csv", description: "Comma-separated extra tags added to every imported item" },
        { long: "--section", value_name: "name", description: "Only sync the named markdown section" },
        { long: "--section-tags", description: "Derive tags from markdown section headings (default; pass --no-section-tags to disable)" },
        { long: "--group-by", value_name: "field", description: "Section the re-export by status (default) | sprint | type (markdown/tasklist only)" },
        { long: "--metadata", description: "Include (pN)/(A)..(E) and due:YYYY-MM-DD tokens in markdown/tasklist re-export" },
        { long: "--priority-map", value_name: "scheme", description: "Priority token scheme for markdown/tasklist re-export: number (default) | letter" },
        { long: "--filter", value_name: "expr", description: "Filter items by status/type in both import and re-export (e.g. status=open,type=Task)" },
        { long: "--sort", value_name: "key", description: "Sort the re-export by priority | deadline | title" },
        { long: "--reverse", description: "Reverse the final re-export order; with --sort this produces descending order" },
        { long: "--allow-empty", description: "Allow sync to replace a non-empty file with an empty export" },
        { long: "--dry-run", description: "Report what would change without writing to pm or the file" },
        // `--json` is a host-owned global flag: do not redeclare it (the host
        // rejects the registration); read it from ctx.global instead.
      ],
      async run(ctx: CommandHandlerContext) {
        const fileArg = (ctx.args && ctx.args[0]) as string | undefined;
        const fileOpt = readStringOption(ctx.options, "file");
        if (!fileArg && !fileOpt) {
          throw new CommandError(
            "Usage: pm todos sync <file> [--format markdown|todotxt|todojson|jsonl|checkbox] [--dry-run]",
            EXIT_CODE.USAGE,
          );
        }
        const filePath = resolve((fileArg ?? fileOpt) as string);

        // A single --format drives both directions. `tasklist` is export-only
        // (no import grammar), so reject it explicitly with a clear message.
        const formatRaw = readStringOption(ctx.options, "format");
        if (formatRaw) {
          const v = formatRaw.toLowerCase();
          if (v === "tasklist" || v === "task-list" || v === "gfm") {
            throw new CommandError(
              "todos sync does not support --format tasklist (tasklist is export-only; use markdown, todotxt, todojson, jsonl, or checkbox)",
              EXIT_CODE.USAGE,
            );
          }
        }
        const importFormat = readImportFormat(ctx.options);
        const exportFormat: TodoExportFormat =
          importFormat === "checkbox" ? "checkbox" : importFormat;

        const itemType = readStringOption(ctx.options, "type") ?? "Task";
        const closedAs = readStringOption(ctx.options, "closed-as", "closedAs") ?? "closed";
        const openAs = readStringOption(ctx.options, "status");
        const priority = readStringOption(ctx.options, "priority");
        const section = readStringOption(ctx.options, "section");
        const extraTags = (readStringOption(ctx.options, "tags") ?? "")
          .split(",").map((t) => t.trim()).filter(Boolean);
        const sectionTags = ctx.options["sectionTags"] !== false && ctx.options["section-tags"] !== false;
        const dryRun = readBoolOption(ctx.options, "dry-run", "dryRun");
        const allowEmpty = readBoolOption(ctx.options, "allow-empty", "allowEmpty");
        // In sync, --status maps unchecked source rows and --type supplies the
        // default type for newly created items. Only --filter selects rows;
        // otherwise those import options would silently erase unrelated items
        // during the re-export half.
        const syncFilter = parseFilterExpression(readStringOption(ctx.options, "filter"));

        // Preserve the original bytes for the destructive-empty guard below.
        // The syntax gate still runs before any pm-store write.
        let originalContent: string;
        try {
          originalContent = readFileSync(filePath, "utf-8");
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const exitCode = /ENOENT|no such file/i.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
          throw new CommandError(`Failed to read sync file ${filePath}: ${msg}`, exitCode);
        }
        preflightValidateImportFiles([filePath], importFormat);

        const importResult = runTodoImport({
          files: [filePath],
          itemType,
          closedAs,
          openAs,
          priority,
          extraTags,
          section,
          sectionTags,
          dryRun,
          pmRoot: ctx.pm_root,
          format: importFormat,
          upsert: true,
          statusFilter: syncFilter?.status,
          typeFilter: syncFilter?.type,
        });

        // Read the dropped report BEFORE the re-export. The import half has
        // already mutated the pm store by this point, so the record of which
        // lines were lost is the only thing standing between the user and a
        // silent partial write. `buildTodoMarkdown` reads pm and parses JSON,
        // both of which can throw; letting it run first meant a re-export
        // failure propagated a bare error and took the dropped report with it,
        // leaving the store modified and no record of what was dropped.
        const droppedLines = importResult.dropped ?? [];

        // Re-export the reconciled pm state back to the same file. The export
        // honours --filter/--group-by/--metadata/--priority-map so the written
        // file matches the user's preferred layout. Under --dry-run nothing is
        // written to pm or disk; the export is computed only to report the
        // post-sync row count.
        let reexport: string;
        let exportCount: number;
        try {
          ({ markdown: reexport, count: exportCount } = buildTodoMarkdown({
            statusFilter: syncFilter?.status,
            typeFilter: syncFilter?.type,
            pmRoot: ctx.pm_root,
            format: exportFormat,
            groupBy: readGroupBy(ctx.options),
            sort: readSort(ctx.options),
            metadata: readBoolOption(ctx.options, "metadata", "include-metadata", "includeMetadata"),
            priorityMap: readPriorityMap(ctx.options),
            reverse: readBoolOption(ctx.options, "reverse"),
          }));
        } catch (error) {
          // With nothing dropped there is no report to protect, so the export
          // failure is the whole story and propagates unchanged. With lines
          // dropped, the report outranks the export error: the file is left
          // untouched either way, but only this path tells the user which lines
          // the store is now missing.
          if (droppedLines.length === 0) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          console.error(
            `sync: imported ${importResult.imported}, updated ${importResult.updated ?? 0}, but DROPPED ${droppedLines.length} item(s), and the re-export then failed (${reason}); NOT writing ${filePath} (see the 'dropped' field for file/line/reason).`,
          );
          return withDroppedReport(
            {
              file: filePath,
              format: importFormat,
              imported: importResult.imported,
              updated: importResult.updated ?? 0,
              skipped: importResult.skipped,
              reexported: 0,
              dryRun,
              reexport_error: reason,
            },
            droppedLines,
          );
        }

        const result = {
          file: filePath,
          format: importFormat,
          imported: importResult.imported,
          updated: importResult.updated ?? 0,
          skipped: importResult.skipped,
          reexported: exportCount,
          dryRun,
        };

        if (dryRun) {
          console.error(
            `[dry-run] sync ${filePath}: import ${importResult.imported}, update ${importResult.updated ?? 0}, skip ${importResult.skipped}, re-export ${exportCount} item(s).`,
          );
          return withDroppedReport({ ...result, previews: importResult.previews }, droppedLines);
        }

        // If the import half dropped any line, the pm store now holds a subset
        // of the file. Re-exporting that subset back over the file would
        // SILENTLY DELETE the dropped lines (the exact data-loss this command
        // must never cause), so refuse the write, report every dropped line on
        // the normal output path, and exit non-zero. The original file bytes
        // are preserved so the user can fix the cause and re-run. This guard
        // runs BEFORE the empty-result refusal: a drop is the primary
        // diagnosis, and an empty export caused entirely by drops must not be
        // misreported as a bare "refusing to replace non-empty file" error.
        if (droppedLines.length > 0) {
          console.error(
            `sync: imported ${importResult.imported}, updated ${importResult.updated ?? 0}, but DROPPED ${droppedLines.length} item(s); NOT writing ${filePath} to avoid losing them (see the 'dropped' field for file/line/reason).`,
          );
          return withDroppedReport(result, droppedLines);
        }

        if (exportCount === 0 && originalContent.trim() !== "" && !allowEmpty) {
          throw new CommandError(
            `Refusing to replace non-empty ${filePath} with an empty sync result. ` +
              "Broaden/remove --filter, or pass --allow-empty to clear the file intentionally.",
            EXIT_CODE.USAGE,
          );
        }

        // An empty write is allowed for an already-empty file or when the user
        // explicitly acknowledges the destructive result with --allow-empty.
        writeFileSync(filePath, reexport, "utf-8");
        if (exportCount === 0) {
          console.error(`sync: imported ${importResult.imported} item(s); cleared ${filePath} because no items remain.`);
        } else {
          console.error(
            `sync: imported ${importResult.imported}, updated ${importResult.updated ?? 0}, skipped ${importResult.skipped}; wrote ${exportCount} item(s) back to ${filePath}.`,
          );
        }
        return result;
      },
    });

    // -----------------------------------------------------------------------
    // Importer: todos  (native `pm import todos` pipeline)
    //
    // Driven by options (config-driven import). Accepts the same knobs as the
    // command: `file`, `glob`, `section`, `closed-as`, `type`, `priority`,
    // `tags`. Reuses the shared import core so behaviour stays identical.
    // -----------------------------------------------------------------------
    // NOTE: registering the importer under the name "todos" makes the pm
    // runtime route `pm todos import` through THIS handler (the action contract
    // shadows the like-named registerCommand). So this handler is the single
    // source of truth for `pm todos import` and must accept the positional file
    // argument (`ctx.args[0]`) exactly as the command did — otherwise the
    // existing CLI usage would silently break.
    api.registerImporter("todos", async (ctx: ImportExportContext) => {
      const dryRun = readBoolOption(ctx.options, "dry-run", "dryRun");
      const glob = readStringOption(ctx.options, "glob");
      const fileArg = (ctx.args && ctx.args[0]) as string | undefined;
      const fileOpt = readStringOption(ctx.options, "file");

      let files: string[];
      if (glob) {
        files = resolveGlob(glob, process.cwd());
        if (files.length === 0 && ctx.pm_root) {
          files = resolveGlob(glob, resolve(ctx.pm_root, ".."));
        }
        if (files.length === 0) {
          throw new CommandError(`No files matched glob: ${glob}`, EXIT_CODE.NOT_FOUND);
        }
        console.error(`Matched ${files.length} file(s) for glob '${glob}'.`);
      } else if (fileArg || fileOpt) {
        files = [resolve((fileArg ?? fileOpt) as string)];
      } else {
        throw new CommandError(
          "Usage: pm todos import <file> [--glob <pattern>] [--section <name>] [--closed-as <status>] [--dry-run]",
          EXIT_CODE.USAGE,
        );
      }

      const itemType = readStringOption(ctx.options, "type") ?? "Task";
      const closedAs = readStringOption(ctx.options, "closed-as", "closedAs") ?? "closed";
      const openAs = readStringOption(ctx.options, "status");
      const priority = readStringOption(ctx.options, "priority");
      const section = readStringOption(ctx.options, "section");
      const extraTags = (readStringOption(ctx.options, "tags") ?? "")
        .split(",").map((t) => t.trim()).filter(Boolean);
      const sectionTags = ctx.options["sectionTags"] !== false && ctx.options["section-tags"] !== false;
      const format = readImportFormat(ctx.options);
      const upsert = readBoolOption(ctx.options, "upsert") || format === "todojson";
      const importFilter = parseFilterExpression(readStringOption(ctx.options, "filter"));

      // Fail-fast syntax gate: this importer is the real `pm todos import` path
      // (the action contract shadows the like-named command). Validate every
      // file before any pm-store write so malformed input aborts immediately
      // with a clear error and leaves the store untouched.
      preflightValidateImportFiles(files, format);

      const { imported, skipped, updated, previews, dropped } = runTodoImport({
        files,
        itemType,
        closedAs,
        openAs,
        priority,
        extraTags,
        section,
        sectionTags,
        dryRun,
        pmRoot: ctx.pm_root,
        format,
        upsert,
        statusFilter: importFilter?.status,
        typeFilter: importFilter?.type,
      });

      if (imported === 0 && skipped === 0 && (updated ?? 0) === 0) {
        console.error("No TODO items found.");
        return { imported: 0, skipped: 0 };
      }

      if (dryRun) {
        const updPart = upsert ? `, update ${updated ?? 0}` : "";
        console.error(`[dry-run] Would import ${imported}${updPart} TODO item(s), skip ${skipped}.`);
        return { dryRun: true, wouldImport: imported, wouldUpdate: updated ?? 0, wouldSkip: skipped, previews };
      }

      const droppedLines = dropped ?? [];
      // A partial import (some lines rejected by pm) must NOT exit 0. The
      // per-line `dropped` report travels in the structured result so it reaches
      // the normal output path (stdout), and `withDroppedReport` sets the
      // non-zero process exit code. The stderr line repeats the count so a
      // human scanning the terminal also sees it next to the import summary.
      if (droppedLines.length > 0) {
        console.error(
          `Imported ${imported}${upsert ? `, updated ${updated ?? 0}` : ""}, but DROPPED ${droppedLines.length} item(s) (see the 'dropped' field for file/line/reason).`,
        );
      } else {
        const updPart = upsert ? `, updated ${updated ?? 0}` : "";
        console.error(`Imported ${imported}${updPart} TODO item(s), skipped ${skipped}.`);
      }
      const base = upsert ? { imported, updated: updated ?? 0, skipped } : { imported, skipped };
      return withDroppedReport(base, droppedLines);
    }, {
      // Declare the same file argument + flag contracts the handler already
      // reads (ctx.args[0], ctx.options.*). Without them the derived
      // `pm todos import` command rejects the positional file ("too many
      // arguments") and every option ("unknown option"), even though the
      // handler supports them — mirroring the working `todos sync` command.
      description:
        "Import TODO items from a markdown/todo.txt/todojson/jsonl/checkbox file into the pm store.",
      intent: "import a markdown/todo.txt/todojson/jsonl/checkbox file into pm items",
      examples: [
        "pm todos import TODO.md",
        "pm todos import backlog.jsonl --format jsonl --upsert",
        "pm todos import todo.txt --format todotxt --status open",
        "pm todos import --glob 'docs/**/*.todo.md' --dry-run",
      ],
      arguments: [
        { name: "file", required: false, description: "Path to the TODO file to import (or use --file/--glob)" },
      ],
      flags: [
        { long: "--file", value_name: "path", description: "Path to the TODO file (alternative to the positional argument)" },
        { long: "--glob", value_name: "pattern", description: "Import every file matching this glob pattern" },
        { long: "--format", value_name: "fmt", description: "File format: markdown (default), todotxt, todojson, jsonl, or checkbox" },
        { long: "--type", value_name: "type", description: "Item type for newly created items (default: Task)" },
        { long: "--closed-as", value_name: "status", description: "Status for checked/closed items (default: closed)" },
        { long: "--status", value_name: "status", description: "Status for open/unchecked items (default: open)" },
        { long: "--priority", value_name: "n", description: "Priority 0-4; overrides markers inferred from text" },
        { long: "--section", value_name: "name", description: "Only import the named markdown section" },
        { long: "--section-tags", description: "Derive tags from markdown section headings (default; pass --no-section-tags to disable)" },
        { long: "--tags", value_name: "csv", description: "Comma-separated extra tags added to every imported item" },
        { long: "--filter", value_name: "expr", description: "Only import rows matching status/type (e.g. status=open,type=Task)" },
        { long: "--upsert", description: "Update existing items in place instead of skipping duplicates" },
        { long: "--dry-run", description: "Report what would change without writing to pm" },
      ],
    });

    // -----------------------------------------------------------------------
    // Exporter: todos  (native `pm export todos` pipeline)
    //
    // Mirrors the `todos export` command so markdown is a first-class
    // import/export pair. Writes to `--output` or prints to stdout.
    // -----------------------------------------------------------------------
    api.registerExporter("todos", async (ctx: ImportExportContext) => {
      const outputPath = readStringOption(ctx.options, "output");
      const filter = readExportFilter(ctx.options);
      const { markdown, count } = buildTodoMarkdown({
        statusFilter: filter.status,
        typeFilter: filter.type,
        pmRoot: ctx.pm_root,
        format: readExportFormat(ctx.options),
        groupBy: readGroupBy(ctx.options),
        sort: readSort(ctx.options),
        metadata: readBoolOption(ctx.options, "metadata", "include-metadata", "includeMetadata"),
        priorityMap: readPriorityMap(ctx.options),
        reverse: readBoolOption(ctx.options, "reverse"),
      });

      if (count === 0) {
        console.error("todos: no items found.");
        return { exported: 0 };
      }

      if (outputPath) {
        const absolutePath = resolve(outputPath);
        writeFileSync(absolutePath, markdown, "utf-8");
        console.error(`todos: wrote ${count} item(s) to ${absolutePath}`);
        return { exported: count, file: absolutePath };
      }

      return { exported: count, markdown };
    }, {
      // Declare the flag contracts the handler already reads so the derived
      // `pm todos export` command accepts them (parity with `todos sync`).
      description:
        "Export pm items to a markdown/todo.txt/tasklist/todojson/jsonl/checkbox TODO file.",
      intent: "export pm items to a markdown/todo.txt/tasklist/todojson/jsonl/checkbox file",
      examples: [
        "pm todos export --output TODO.md",
        "pm todos export --format jsonl --output backlog.jsonl",
        "pm todos export --status open --sort priority --reverse",
      ],
      flags: [
        { long: "--output", value_name: "path", description: "Write the export to this file (default: stdout)" },
        { long: "--format", value_name: "fmt", description: "Output format: markdown (default), todotxt, tasklist, todojson, jsonl, or checkbox" },
        { long: "--status", value_name: "status", description: "Only export items with this status" },
        { long: "--type", value_name: "type", description: "Only export items of this type" },
        { long: "--filter", value_name: "expr", description: "Only export items matching status/type (e.g. status=open,type=Task)" },
        { long: "--group-by", value_name: "field", description: "Section the export by status (default) | sprint | type" },
        { long: "--sort", value_name: "key", description: "Sort the export by priority | deadline | title" },
        { long: "--metadata", description: "Include (pN)/(A)..(E) and due:YYYY-MM-DD tokens in markdown/tasklist output" },
        { long: "--priority-map", value_name: "scheme", description: "Priority token scheme for --metadata: number (default) | letter" },
        { long: "--reverse", description: "Reverse the final export order (composes with --sort)" },
      ],
    });

    // -----------------------------------------------------------------------
    // Importer: todos-import  (legacy alias — retained for backward compat)
    // -----------------------------------------------------------------------
    api.registerImporter("todos-import", async (ctx: ImportExportContext) => {
      const filePath = readStringOption(ctx.options, "file");
      if (!filePath) {
        console.error("todos-import: no 'file' provided — skipping.");
        return;
      }

      const closedAs = readStringOption(ctx.options, "closed-as", "closedAs") ?? "closed";
      const legacyFormat = readImportFormat(ctx.options);
      // Fail-fast syntax gate before any pm-store write.
      preflightValidateImportFiles([resolve(filePath)], legacyFormat);
      const { imported, skipped, dropped } = runTodoImport({
        files: [resolve(filePath)],
        itemType: readStringOption(ctx.options, "type") ?? "Task",
        closedAs,
        priority: readStringOption(ctx.options, "priority"),
        extraTags: [],
        section: readStringOption(ctx.options, "section"),
        sectionTags: false,
        dryRun: false,
        pmRoot: ctx.pm_root,
        format: readImportFormat(ctx.options),
      });

      const droppedLines = dropped ?? [];
      // Mirror the primary importer's contract: a partial legacy import must
      // not be reported as success. The dropped report rides the structured
      // result (stdout) and withDroppedReport sets the non-zero exit code.
      if (droppedLines.length > 0) {
        console.error(`todos-import: imported ${imported}, but DROPPED ${droppedLines.length} item(s) (see the 'dropped' field).`);
      } else {
        console.error(`todos-import: done — imported ${imported}, skipped ${skipped}.`);
      }
      return withDroppedReport({ imported, skipped }, droppedLines);
    });

    // -----------------------------------------------------------------------
    // Preflight: fail-fast syntax gate for `pm todos import`
    //
    // This registers the SDK preflight override (manifest capability
    // "preflight"). It is scoped to the import path and runs the same up-front
    // syntax validation as the handler-level gate, so malformed input is caught
    // as early as possible in the pipeline.
    //
    // IMPORTANT (runtime fact): the pm runtime's `runPreflightOverride` wraps
    // this callback in a try/catch and SWALLOWS a thrown error (it merely emits
    // a `preflight_override_failed` warning and continues). So a throw here can
    // NOT by itself abort the command. The authoritative fail-fast enforcement
    // therefore lives inside the import handler/importer
    // (`preflightValidateImportFiles`), which runs as the command action where a
    // thrown CommandError DOES produce a clean non-zero exit before any
    // pm-store write. This override is the documented, scoped preflight surface
    // and a best-effort early check; it returns a pass-through decision so it
    // never changes the runtime's gate behaviour.
    //
    // Ownership is declared STATICALLY via `commands` so the HOST scopes
    // dispatch. An unscoped registration is owned by every command, so pm
    // invokes it on every command and the callback body is the only thing
    // stopping it from acting. Declaring the command here means the override is
    // invoked only for `todos import` — which is what the previous runtime
    // `ctx.command` guard enforced dynamically, and why that guard is now gone.
    //
    // This is about dispatch only. It does NOT change the `pm health`
    // `extension_preflight_override_collision` warnings: that check does not
    // inspect declared ownership, so it reports the same pairwise clique over
    // every extension registering a preflight, scoped or not. Verified before
    // and after this change; filed upstream as unbraind/pm-cli#971.
    // -----------------------------------------------------------------------
    api.registerPreflight({
      commands: ["todos import"],
      run: (ctx: PreflightOverrideContext) => {
        const d = ctx?.decision ?? {};
        const passthrough = {
          enforce_item_format_gate: d.enforce_item_format_gate ?? true,
          run_preflight_item_format_sync: d.run_preflight_item_format_sync ?? false,
          run_extension_migrations: d.run_extension_migrations ?? true,
          enforce_mandatory_migration_gate: d.enforce_mandatory_migration_gate ?? false,
        };

        // Resolve the input file(s) exactly as the import handler does.
        const glob = readStringOption(ctx.options ?? {}, "glob");
        const fileArg = (ctx.args && ctx.args[0]) as string | undefined;
        const fileOpt = readStringOption(ctx.options ?? {}, "file");
        let files: string[] = [];
        if (glob) {
          files = resolveGlob(glob, process.cwd());
          if (files.length === 0 && ctx.pm_root) {
            files = resolveGlob(glob, resolve(ctx.pm_root, ".."));
          }
        } else if (fileArg || fileOpt) {
          files = [resolve((fileArg ?? fileOpt) as string)];
        }
        if (files.length === 0) return passthrough; // usage error surfaces in the handler

        const format = readImportFormat(ctx.options ?? {});
        // Best-effort early gate. The handler re-runs (and enforces) the same
        // check, so even though a throw here is swallowed by the runtime, the
        // import still fails fast with no partial write.
        preflightValidateImportFiles(files, format);
        return passthrough;
      },
    });
  },
});
