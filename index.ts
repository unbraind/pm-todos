// pm-todos — Markdown TODO round-trip for pm-cli

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time and exits with a generic code. We mirror the SDK's EXIT_CODE
// contract here rather than importing it: standalone-installed extensions load
// only their own `dist/`, so `@unbrained/pm-cli` is not resolvable at runtime.
const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

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
}

// ---------------------------------------------------------------------------
// Markdown TODO parser
// ---------------------------------------------------------------------------

// A checkbox line: optional leading whitespace, a `-`/`*`/`+` bullet, then the
// `[ ]` / `[x]` marker, then the text. Indentation is preserved to detect
// nested sub-tasks.
const TODO_RE = /^(\s*)[-*+] \[([ xX])\] (.+)$/;
// A markdown section header (`## Title`, any level). We treat the heading text
// as a tag for every TODO that follows it (until the next heading).
const HEADER_RE = /^(#{1,6})\s+(.+?)\s*#*$/;

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
function readImportFormat(options: Record<string, unknown>): "markdown" | "todotxt" {
  const raw = readStringOption(options, "format");
  if (raw === undefined) return "markdown";
  const v = raw.toLowerCase();
  if (v === "markdown" || v === "md") return "markdown";
  if (v === "todotxt" || v === "todo.txt") return "todotxt";
  throw new CommandError(`Unknown --format '${raw}' (expected markdown|todotxt)`, EXIT_CODE.USAGE);
}

/**
 * Read and validate the export `--format` option (markdown | todotxt | tasklist).
 */
function readExportFormat(options: Record<string, unknown>): "markdown" | "todotxt" | "tasklist" {
  const raw = readStringOption(options, "format");
  if (raw === undefined) return "markdown";
  const v = raw.toLowerCase();
  if (v === "markdown" || v === "md") return "markdown";
  if (v === "todotxt" || v === "todo.txt") return "todotxt";
  if (v === "tasklist" || v === "task-list" || v === "gfm") return "tasklist";
  throw new CommandError(`Unknown --format '${raw}' (expected markdown|todotxt|tasklist)`, EXIT_CODE.USAGE);
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
const PM_ID_COMMENT_RE = /\s*<!--\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\s*-->\s*$/;

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
const TYPE_TAG_RE = new RegExp(`\\s*\\[(${PM_ITEM_TYPES.join("|")})\\]\\s*$`);

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
      currentSection = header[2].trim();
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

function markdownMetadataSuffix(item: PmItem): string {
  const parts: string[] = [];
  if (item.priority !== undefined && item.priority !== null) {
    const n = Math.max(0, Math.min(4, Math.trunc(item.priority)));
    parts.push(`(p${n})`);
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
export function renderTaskList(items: PmItem[], groupBy: string, metadata = false): string {
  const groups = groupItems(items, groupBy);
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`## ${group.heading}`, "");
    for (const item of group.items) {
      const check = mapPmStatusToChecked(item.status) ? "x" : " ";
      lines.push(`- [${check}] ${item.title}${metadata ? markdownMetadataSuffix(item) : ""} <!-- ${item.id} -->`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
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
  format: "markdown" | "todotxt",
): { issues: ValidationIssue[]; taskCount: number } {
  const issues: ValidationIssue[] = [];
  let taskCount = 0;
  const lines = content.split("\n");

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
  format: "markdown" | "todotxt",
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
  format: "markdown" | "todotxt";
  /**
   * When true, re-importing matches existing pm items and UPDATES them instead
   * of creating duplicates. Matching keys (in order): the embedded
   * `<!-- pm-id -->` comment, else a stable (title + section) signature. Default
   * false → every item is always created (historical behaviour, unchanged).
   */
  upsert?: boolean;
}

/**
 * Internal normalized shape a parsed line (markdown or todo.txt) is reduced to
 * before becoming a pm item. Lets the import core share one create path.
 */
interface NormalizedTodo {
  checked: boolean;
  text: string;
  priority?: number;
  tags: string[];
  deadline?: string;
  section?: string;
  indent: number;
  lineNumber: number;
  file?: string;
  /** pm id parsed from a `<!-- pm-id -->` comment (markdown only); upsert key. */
  pmId?: string;
  /** Item type recovered from the exporter's ` [Type]` tag (markdown round-trip). */
  itemType?: string;
}

/**
 * Read+parse one file into normalized todos for either supported format. For
 * todo.txt, `+project`/`@context` become tags and `due:` becomes the deadline.
 */
function parseFileToNormalized(
  md: string,
  file: string | undefined,
  format: "markdown" | "todotxt",
): NormalizedTodo[] {
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

interface TodoImportResult {
  imported: number;
  skipped: number;
  /** Number of existing items updated in place (only meaningful with --upsert). */
  updated?: number;
  previews?: Array<Record<string, unknown>>;
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
    const entry: ExistingTodoItem = { pmId: item.id, status: item.status, title: item.title };
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

/** Fetch current workspace items via `pm list-all --json` (for the upsert index). */
function readPmItemsForUpsert(pmRoot: string): PmItem[] {
  const result = spawnSync(
    "pm",
    ["--path", pmRoot, "--json", "list-all", "--limit", "10000"],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new CommandError(result.stderr || "pm list-all failed (needed for --upsert)");
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.results ?? [];
    return items as PmItem[];
  } catch {
    throw new CommandError("Could not parse `pm list-all --json` output (needed for --upsert).");
  }
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

  // With --upsert, build the lookup indexes once up front (also in dry-run so
  // the preview reports create vs. update accurately). Without --upsert these
  // stay empty and every item is created — the unchanged historical behaviour.
  const index = opts.upsert
    ? buildExistingTodoIndex(readPmItemsForUpsert(opts.pmRoot))
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

      const status = mapStatusToPm(todo.checked, opts.closedAs, opts.openAs ?? "open");

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
          if (status !== existing.status) updArgs.push("--status", status);
          if (priority !== undefined && priority !== "") updArgs.push("--priority", priority);
          if (tags.length > 0) updArgs.push("--tags", tags.join(",")); // --tags replaces
          if (todo.deadline) updArgs.push("--deadline", todo.deadline);

          const result = spawnSync("pm", updArgs, { encoding: "utf-8" });
          if (result.status !== 0) {
            throw new Error(result.stderr || "pm update failed");
          }
          updated++;
        } else {
          const spawnArgs = [
            "--path", opts.pmRoot,
            ...(opts.upsert ? ["--json"] : []),
            "create",
            "--title", todo.text,
            "--type", itemType,
            "--status", status,
            "--description", `Imported from ${todo.file ?? "stdin"} line ${todo.lineNumber}`,
          ];
          if (priority !== undefined && priority !== "") spawnArgs.push("--priority", priority);
          if (tags.length > 0) spawnArgs.push("--tags", tags.join(","));
          if (todo.deadline) spawnArgs.push("--deadline", todo.deadline);

          const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
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
              const entry: ExistingTodoItem = { pmId: createdId, status };
              index.byId.set(createdId, entry);
              const sig = todoSignatureKey(todo.text);
              if (sig && !index.bySig.has(sig)) index.bySig.set(sig, entry);
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${todo.file}:${todo.lineNumber}: ${existing ? "update" : "create"} failed — ${msg}`);
        skipped++;
      }
    }
  }

  return { imported, skipped, updated, previews: opts.dryRun ? previews : undefined };
}

// ---------------------------------------------------------------------------
// Shared export core (used by `todos export` command + `todos` exporter)
// ---------------------------------------------------------------------------

interface TodoExportOptions {
  statusFilter?: string;
  typeFilter?: string;
  pmRoot: string;
  /** Output format: markdown (default), todotxt, or tasklist. */
  format?: "markdown" | "todotxt" | "tasklist";
  /** Section grouping for markdown/tasklist: status (default) | sprint | type. */
  groupBy?: string;
  /** Optional ordering applied after filtering: priority | deadline | title. */
  sort?: "priority" | "deadline" | "title";
  /** Include parseable priority/deadline tokens in markdown/tasklist output. */
  metadata?: boolean;
}

/** Fetch + filter pm items via `pm list-all --json`. */
function fetchPmItems(opts: TodoExportOptions): PmItem[] {
  const result = spawnSync(
    "pm",
    ["--path", opts.pmRoot, "list-all", "--json"],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new CommandError(result.stderr || "pm list-all failed");
  }
  let items: PmItem[] = JSON.parse(result.stdout).items ?? [];
  if (opts.statusFilter) items = items.filter((i) => i.status === opts.statusFilter);
  if (opts.typeFilter) items = items.filter((i) => i.type === opts.typeFilter);
  if (opts.sort) items = sortItems(items, opts.sort);
  return items;
}

/**
 * Render the default-markdown TODO export. Kept byte-identical to the original
 * (the `# TODO` header, export-timestamp comment, `## Open`/`## Done` sections,
 * and the `[type]` annotation on open items) so existing behaviour is stable.
 * This is the path used when no `--group-by` (or `--group-by status`) is set.
 */
export function renderDefaultMarkdown(items: PmItem[], nowIso: string, metadata = false): string {
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
      const meta = metadata ? markdownMetadataSuffix(item) : "";
      const typeTag = item.type ? ` [${item.type}]` : "";
      lines.push(`- [${check}] ${item.title}${meta}${typeTag} <!-- ${item.id} -->`);
    }
    lines.push("");
  }

  if (closedItems.length > 0) {
    lines.push("## Done", "");
    for (const item of closedItems) {
      lines.push(`- [x] ${item.title}${metadata ? markdownMetadataSuffix(item) : ""} <!-- ${item.id} -->`);
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
export function renderGroupedMarkdown(items: PmItem[], groupBy: string, nowIso: string, metadata = false): string {
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
      lines.push(`- [${check}] ${item.title}${metadata ? markdownMetadataSuffix(item) : ""} <!-- ${item.id} -->`);
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

  if (format === "todotxt") {
    return { markdown: serializeTodoTxt(items), count: items.length };
  }
  if (format === "tasklist") {
    return { markdown: renderTaskList(items, groupBy ?? "status", opts.metadata), count: items.length };
  }
  // markdown
  if (groupBy && groupBy !== "status") {
    return { markdown: renderGroupedMarkdown(items, groupBy, new Date().toISOString(), opts.metadata), count: items.length };
  }
  return { markdown: renderDefaultMarkdown(items, new Date().toISOString(), opts.metadata), count: items.length };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default defineExtension({
  name: "pm-todos",
  version: "2026.6.5-1",

  activate(api: any) {
    // -----------------------------------------------------------------------
    // Command: pm todos import <file>
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "todos import",
      description:
        "Import markdown TODO items (- [ ] and - [x]) as pm items. " +
        "Each checkbox becomes a pm Task; checked items are closed. " +
        "Supports nested sub-tasks, multiple files via --glob, section headers " +
        "(## …) mapped to tags, and priority markers ((p1), !).",
      intent: "import markdown checkboxes as pm items",
      examples: [
        "pm todos import TODO.md",
        "pm todos import notes.md --dry-run",
        "pm todos import backlog.md --type Task --priority 2",
        "pm todos import --glob 'docs/**/*.md'",
        "pm todos import TODO.md --section Backlog",
        "pm todos import TODO.md --closed-as canceled",
        "pm todos import TODO.md --status in_progress",
        "pm todos import todo.txt --format todotxt",
        "pm todos import TODO.md --upsert",
      ],
      flags: [
        { long: "--dry-run", description: "Preview without writing" },
        { long: "--upsert", description: "Update existing items (matched by embedded <!-- pm-id --> comment, else title+section) instead of creating duplicates" },
        { long: "--format", value_name: "fmt", description: "Source format: markdown (default) | todotxt" },
        { long: "--type", value_name: "type", description: "Item type for imported items (default: Task)" },
        { long: "--priority", value_name: "n", description: "Priority for imported items (0-4); overrides inferred markers" },
        { long: "--tags", value_name: "tags", description: "Comma-separated tags to apply to all items" },
        { long: "--glob", value_name: "pattern", description: "Import every markdown file matching this glob (e.g. 'docs/**/*.md')" },
        { long: "--section", value_name: "name", description: "Import only items under this ## section heading" },
        { long: "--closed-as", value_name: "status", description: "Status to assign checked items (default: closed)" },
        { long: "--status", value_name: "status", description: "Status to assign open (unchecked) items (default: open)" },
        { long: "--no-section-tags", description: "Do not derive tags from section headings" },
      ],
      async run(ctx: any) {
        const dryRun = readBoolOption(ctx.options, "dry-run", "dryRun");
        const upsert = readBoolOption(ctx.options, "upsert");
        const format = readImportFormat(ctx.options);
        const itemType = (ctx.options["type"] as string) || "Task";
        const priority = ctx.options["priority"] as string | undefined;
        const tagsOpt = ctx.options["tags"] as string | undefined;
        const glob = readStringOption(ctx.options, "glob");
        const section = readStringOption(ctx.options, "section");
        const closedAs = readStringOption(ctx.options, "closed-as", "closedAs") ?? "closed";
        const openAs = readStringOption(ctx.options, "status");
        // `--no-section-tags` arrives as sectionTags=false; default on.
        const sectionTags = ctx.options["sectionTags"] !== false && ctx.options["section-tags"] !== false;

        let files: string[];
        if (glob) {
          files = resolveGlob(glob, process.cwd());
          if (files.length === 0) {
            throw new CommandError(`No files matched glob: ${glob}`, EXIT_CODE.NOT_FOUND);
          }
          console.error(`Matched ${files.length} file(s) for glob '${glob}'.`);
        } else {
          const filePath = ctx.args[0] as string | undefined;
          if (!filePath) {
            throw new CommandError(
              "Usage: pm todos import <file> [--glob <pattern>] [--section <name>] [--closed-as <status>] [--dry-run]",
              EXIT_CODE.USAGE,
            );
          }
          files = [resolve(filePath)];
        }

        const extraTags = (tagsOpt ?? "").split(",").map((t) => t.trim()).filter(Boolean);

        // Fail-fast syntax gate: validate ALL input files before any pm-store
        // write so malformed input aborts cleanly with no partial import.
        preflightValidateImportFiles(files, format);

        const { imported, skipped, updated, previews } = runTodoImport({
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

        const updPart = upsert ? `, updated ${updated ?? 0}` : "";
        console.error(`Imported ${imported}${updPart} TODO item(s), skipped ${skipped}.`);
        return upsert ? { imported, updated: updated ?? 0, skipped } : { imported, skipped };
      },
    });

    // -----------------------------------------------------------------------
    // Command: pm todos export
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "todos export",
      description:
        "Export pm items as a markdown TODO list, todo.txt, or GitHub task list. " +
        "Open items become - [ ], closed/canceled items become - [x].",
      intent: "export pm items to markdown TODO format",
      examples: [
        "pm todos export",
        "pm todos export --output TODO.md",
        "pm todos export --status open --output backlog.md",
        "pm todos export --type Task",
        "pm todos export --format todotxt --output todo.txt",
        "pm todos export --format tasklist --group-by sprint",
        "pm todos export --group-by type",
        "pm todos export --sort priority",
        "pm todos export --sort deadline --status open",
        "pm todos export --metadata --output TODO.md",
      ],
      flags: [
        { long: "--output", value_name: "file", description: "Write output to file (default: stdout)" },
        { long: "--format", value_name: "fmt", description: "Output format: markdown (default) | todotxt | tasklist" },
        { long: "--group-by", value_name: "field", description: "Section markdown/tasklist by status (default) | sprint | type" },
        { long: "--sort", value_name: "key", description: "Sort items by priority | deadline | title (preserves pm order if unset)" },
        { long: "--status", value_name: "status", description: "Filter by status" },
        { long: "--type", value_name: "type", description: "Filter by item type" },
        { long: "--metadata", description: "Include parseable `(pN)` and `due:YYYY-MM-DD` tokens in markdown/tasklist output" },
      ],
      async run(ctx: any) {
        const outputPath = ctx.options["output"] as string | undefined;
        const format = readExportFormat(ctx.options);
        const groupBy = readGroupBy(ctx.options);
        const sort = readSort(ctx.options);
        const metadata = readBoolOption(ctx.options, "metadata", "include-metadata", "includeMetadata");

        console.error("Fetching pm items…");
        const { markdown, count } = buildTodoMarkdown({
          statusFilter: ctx.options["status"] as string | undefined,
          typeFilter: ctx.options["type"] as string | undefined,
          pmRoot: ctx.pm_root,
          format,
          groupBy,
          sort,
          metadata,
        });

        if (count === 0) {
          console.error("No items found.");
          return { exported: 0 };
        }

        if (outputPath) {
          const absolutePath = resolve(outputPath);
          writeFileSync(absolutePath, markdown, "utf-8");
          console.error(`Exported ${count} item(s) to: ${absolutePath}`);
          return { exported: count, file: absolutePath };
        }

        console.error(`Exported ${count} item(s).`);
        return { exported: count, markdown };
      },
    });

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
        "pm todos validate TODO.md --json",
      ],
      flags: [
        { long: "--format", value_name: "fmt", description: "File format: markdown (default) | todotxt" },
        { long: "--json", description: "Emit a JSON report" },
      ],
      async run(ctx: any) {
        const format = readImportFormat(ctx.options);
        const asJson = readBoolOption(ctx.options, "json");
        const filePath = ctx.args[0] as string | undefined;
        if (!filePath) {
          throw new CommandError(
            "Usage: pm todos validate <file> [--format markdown|todotxt] [--json]",
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
    api.registerImporter("todos", async (ctx: any) => {
      const dryRun = readBoolOption(ctx.options, "dry-run", "dryRun");
      const upsert = readBoolOption(ctx.options, "upsert");
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

      // Fail-fast syntax gate: this importer is the real `pm todos import` path
      // (the action contract shadows the like-named command). Validate every
      // file before any pm-store write so malformed input aborts immediately
      // with a clear error and leaves the store untouched.
      preflightValidateImportFiles(files, format);

      const { imported, skipped, updated, previews } = runTodoImport({
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

      const updPart = upsert ? `, updated ${updated ?? 0}` : "";
      console.error(`Imported ${imported}${updPart} TODO item(s), skipped ${skipped}.`);
      return upsert ? { imported, updated: updated ?? 0, skipped } : { imported, skipped };
    });

    // -----------------------------------------------------------------------
    // Exporter: todos  (native `pm export todos` pipeline)
    //
    // Mirrors the `todos export` command so markdown is a first-class
    // import/export pair. Writes to `--output` or prints to stdout.
    // -----------------------------------------------------------------------
    api.registerExporter("todos", async (ctx: any) => {
      const outputPath = readStringOption(ctx.options, "output");
      const { markdown, count } = buildTodoMarkdown({
        statusFilter: readStringOption(ctx.options, "status"),
        typeFilter: readStringOption(ctx.options, "type"),
        pmRoot: ctx.pm_root,
        format: readExportFormat(ctx.options),
        groupBy: readGroupBy(ctx.options),
        sort: readSort(ctx.options),
        metadata: readBoolOption(ctx.options, "metadata", "include-metadata", "includeMetadata"),
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

      console.log(markdown);
      return { exported: count, markdown };
    });

    // -----------------------------------------------------------------------
    // Importer: todos-import  (legacy alias — retained for backward compat)
    // -----------------------------------------------------------------------
    api.registerImporter("todos-import", async (ctx: any) => {
      const filePath = readStringOption(ctx.options, "file");
      if (!filePath) {
        console.error("todos-import: no 'file' provided — skipping.");
        return;
      }

      const closedAs = readStringOption(ctx.options, "closed-as", "closedAs") ?? "closed";
      const legacyFormat = readImportFormat(ctx.options);
      // Fail-fast syntax gate before any pm-store write.
      preflightValidateImportFiles([resolve(filePath)], legacyFormat);
      const { imported, skipped } = runTodoImport({
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

      console.error(`todos-import: done — imported ${imported}, skipped ${skipped}.`);
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
    // -----------------------------------------------------------------------
    api.registerPreflight((ctx: any) => {
      const d = ctx?.decision ?? {};
      const passthrough = {
        enforce_item_format_gate: d.enforce_item_format_gate ?? true,
        run_preflight_item_format_sync: d.run_preflight_item_format_sync ?? false,
        run_extension_migrations: d.run_extension_migrations ?? true,
        enforce_mandatory_migration_gate: d.enforce_mandatory_migration_gate ?? false,
      };

      // Scope strictly to the import command; never touch export/validate.
      if (ctx?.command !== "todos import") return passthrough;

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
    });
  },
});
