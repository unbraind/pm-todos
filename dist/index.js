// pm-todos — Markdown TODO round-trip for pm-cli
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
const defineExtension = ((extension) => extension);
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
};
class CommandError extends Error {
    exitCode;
    constructor(message, exitCode = EXIT_CODE.GENERIC_FAILURE) {
        super(message);
        this.name = "CommandError";
        this.exitCode = exitCode;
    }
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
function readBoolOption(options, ...keys) {
    for (const key of keys) {
        if (options[key] !== undefined)
            return Boolean(options[key]);
    }
    return false;
}
/**
 * Read the first defined string option among the given keys (handles both the
 * kebab-case and camelCase forms the runtime may use, e.g. `closed-as` /
 * `closedAs`).
 */
function readStringOption(options, ...keys) {
    for (const key of keys) {
        const v = options[key];
        if (v !== undefined && v !== null)
            return String(v);
    }
    return undefined;
}
/**
 * Read and validate the import `--format` option (markdown | todotxt).
 * Defaults to markdown (current behaviour). Throws a USAGE CommandError on an
 * unrecognised value so typos fail loudly instead of silently importing nothing.
 */
function readImportFormat(options) {
    const raw = readStringOption(options, "format");
    if (raw === undefined)
        return "markdown";
    const v = raw.toLowerCase();
    if (v === "markdown" || v === "md")
        return "markdown";
    if (v === "todotxt" || v === "todo.txt")
        return "todotxt";
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
function readExportFormat(options) {
    const raw = readStringOption(options, "format");
    if (raw === undefined)
        return "markdown";
    const v = raw.toLowerCase();
    if (v === "markdown" || v === "md")
        return "markdown";
    if (v === "todotxt" || v === "todo.txt")
        return "todotxt";
    if (v === "tasklist" || v === "task-list" || v === "gfm")
        return "tasklist";
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
function readGroupBy(options) {
    const raw = readStringOption(options, "group-by", "groupBy");
    if (raw === undefined)
        return undefined;
    const v = raw.toLowerCase();
    if (v === "status" || v === "sprint" || v === "type")
        return v;
    throw new CommandError(`Unknown --group-by '${raw}' (expected status|sprint|type)`, EXIT_CODE.USAGE);
}
/**
 * Read and validate the export `--sort` option (priority | deadline | title).
 * Returns undefined when absent (preserves pm's native ordering).
 */
function readSort(options) {
    const raw = readStringOption(options, "sort");
    if (raw === undefined)
        return undefined;
    const v = raw.toLowerCase();
    if (v === "priority" || v === "deadline" || v === "title")
        return v;
    throw new CommandError(`Unknown --sort '${raw}' (expected priority|deadline|title)`, EXIT_CODE.USAGE);
}
/**
 * Read and validate the export `--priority-map` option (number | letter).
 * `number` (default) emits `(p0)`..`(p4)` tokens in markdown/tasklist metadata;
 * `letter` emits todo.txt-style `(A)`..`(E)` letters instead. Unknown values throw
 * a USAGE error so typos surface before any export write.
 */
function readPriorityMap(options) {
    const raw = readStringOption(options, "priority-map", "priorityMap");
    if (raw === undefined)
        return "number";
    const v = raw.toLowerCase();
    if (v === "number" || v === "numbers" || v === "num" || v === "p")
        return "number";
    if (v === "letter" || v === "letters" || v === "alpha" || v === "a")
        return "letter";
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
export function parseFilterExpression(raw) {
    if (raw === undefined || raw.trim() === "")
        return undefined;
    const out = {};
    for (const part of raw.split(",")) {
        const token = part.trim();
        if (token === "")
            continue;
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
function readExportFilter(options) {
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
function readBoundedIntOption(options, config) {
    const raw = readStringOption(options, config.key);
    if (raw === undefined)
        return config.defaultValue;
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
export function sortItems(items, sort) {
    if (!sort)
        return items;
    const copy = [...items];
    if (sort === "priority") {
        copy.sort((a, b) => {
            const pa = a.priority ?? Number.POSITIVE_INFINITY;
            const pb = b.priority ?? Number.POSITIVE_INFINITY;
            return pa - pb;
        });
    }
    else if (sort === "deadline") {
        copy.sort((a, b) => {
            const da = a.deadline ?? "￿";
            const db = b.deadline ?? "￿";
            return da < db ? -1 : da > db ? 1 : 0;
        });
    }
    else {
        copy.sort((a, b) => (a.title ?? "").toLowerCase().localeCompare((b.title ?? "").toLowerCase()));
    }
    return copy;
}
const CONTEXT_STATUS_ORDER = {
    in_progress: 0,
    blocked: 1,
    open: 2,
    draft: 3,
    closed: 4,
    canceled: 5,
};
function normalizeDeadlineDate(deadline) {
    if (!deadline)
        return undefined;
    const m = /(\d{4}-\d{2}-\d{2})/.exec(deadline);
    return m?.[1];
}
function compareText(a, b) {
    return a.localeCompare(b, undefined, { sensitivity: "base" });
}
function toSortedCountRecord(countMap, compareKeys) {
    const entries = [...countMap.entries()];
    entries.sort((a, b) => {
        if (a[1] !== b[1])
            return b[1] - a[1];
        if (compareKeys)
            return compareKeys(a[0], b[0]);
        return compareText(a[0], b[0]);
    });
    return Object.fromEntries(entries);
}
/**
 * Default focus ordering for `pm todos context`: active work first, then
 * urgency (priority/deadline), then recent updates.
 */
export function sortItemsForContext(items) {
    const copy = [...items];
    copy.sort((a, b) => {
        const statusRankA = CONTEXT_STATUS_ORDER[a.status] ?? 99;
        const statusRankB = CONTEXT_STATUS_ORDER[b.status] ?? 99;
        if (statusRankA !== statusRankB)
            return statusRankA - statusRankB;
        const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
        const priorityB = b.priority ?? Number.POSITIVE_INFINITY;
        if (priorityA !== priorityB)
            return priorityA - priorityB;
        const dueA = normalizeDeadlineDate(a.deadline) ?? "9999-12-31";
        const dueB = normalizeDeadlineDate(b.deadline) ?? "9999-12-31";
        if (dueA !== dueB)
            return dueA.localeCompare(dueB);
        const updatedA = a.updated_at ?? "";
        const updatedB = b.updated_at ?? "";
        if (updatedA !== updatedB)
            return updatedB.localeCompare(updatedA);
        return compareText(a.title ?? "", b.title ?? "");
    });
    return copy;
}
/**
 * Build a compact, high-signal context payload for agents:
 * aggregate counts + a bounded focus list.
 */
export function buildTodoContextSnapshot(items, options) {
    const generatedAt = options.nowIso ?? new Date().toISOString();
    const today = generatedAt.slice(0, 10);
    const todayEpoch = Date.parse(`${today}T00:00:00.000Z`);
    const soonEpoch = todayEpoch + 7 * 24 * 60 * 60 * 1000;
    let highPriority = 0;
    let overdue = 0;
    let dueWithin7Days = 0;
    let withoutDeadline = 0;
    const byStatusMap = new Map();
    const byTypeMap = new Map();
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
        }
        else if (dueEpoch <= soonEpoch) {
            dueWithin7Days++;
        }
    }
    const ordered = options.sort ? sortItems(items, options.sort) : sortItemsForContext(items);
    const focus = ordered.slice(0, options.limit).map((item) => {
        const row = {
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
            byStatus: toSortedCountRecord(byStatusMap, (a, b) => (CONTEXT_STATUS_ORDER[a] ?? 99) - (CONTEXT_STATUS_ORDER[b] ?? 99) || compareText(a, b)),
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
function extractPriority(text) {
    let priority;
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
export function extractMarkdownDue(text) {
    const dueRe = /(^|\s)due:(\d{4}-\d{2}-\d{2})(?=\s|$)/;
    const match = dueRe.exec(text);
    if (!match)
        return { text };
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
function extractTrailing(text, regex) {
    const m = regex.exec(text);
    if (!m)
        return { text };
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
export function extractPmIdComment(text) {
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
];
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
export function extractTypeTag(text) {
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
export function resolveUpsertTitleType(parsedText, parsedType, existingTitle) {
    if (parsedType &&
        existingTitle &&
        existingTitle.replace(/\s+/g, " ").trim() === `${parsedText} [${parsedType}]`) {
        return { title: existingTitle, type: undefined };
    }
    return { title: parsedText, type: parsedType };
}
/**
 * Normalise a section heading into a tag-safe slug (lowercase, dashes).
 */
function sectionToTag(section) {
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
export function parseMarkdownTodos(md, file) {
    const lines = md.split("\n");
    const todos = [];
    let currentSection;
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
function filterBySection(todos, section) {
    const want = section.trim().toLowerCase();
    return todos.filter((t) => (t.section ?? "").toLowerCase() === want);
}
function mapStatusToPm(checked, closedAs, openAs = "open") {
    return checked ? closedAs : openAs;
}
function mapPmStatusToChecked(status) {
    return status === "closed" || status === "canceled";
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function markdownMetadataSuffix(item, priorityMap = "number") {
    const parts = [];
    if (item.priority !== undefined && item.priority !== null) {
        const n = Math.max(0, Math.min(4, Math.trunc(item.priority)));
        if (priorityMap === "letter") {
            parts.push(`(${String.fromCharCode(65 + n)})`);
        }
        else {
            parts.push(`(p${n})`);
        }
    }
    if (item.deadline) {
        const date = item.deadline.slice(0, 10);
        if (DATE_RE.test(date))
            parts.push(`due:${date}`);
    }
    return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
/**
 * True when `s` is a real ISO calendar date `YYYY-MM-DD` (right shape AND a
 * valid month/day, e.g. rejects `2026-13-99`). Used by validation; the looser
 * `DATE_RE` is fine for serialization where pm already produced the date.
 */
function isValidIsoDate(s) {
    if (!DATE_RE.test(s))
        return false;
    const [y, m, d] = s.split("-").map((n) => parseInt(n, 10));
    if (m < 1 || m > 12 || d < 1 || d > 31)
        return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/**
 * Map a todo.txt priority letter to a pm numeric priority.
 * todo.txt: `(A)` is highest. pm: `0` is highest.
 * `(A)`→0, `(B)`→1, … `(E)`→4. Letters beyond E (F..Z) clamp to 4 (lowest).
 * Returns undefined for an absent/invalid letter.
 */
export function priorityLetterToPm(letter) {
    if (!letter)
        return undefined;
    const code = letter.toUpperCase().charCodeAt(0);
    if (code < 65 || code > 90)
        return undefined; // not A..Z
    return Math.min(4, code - 65);
}
/**
 * Map a pm numeric priority to a todo.txt priority letter.
 * `0`→`A`, `1`→`B`, … `4`→`E`. Out-of-range values clamp into A..E.
 * Returns undefined when priority is undefined.
 */
export function pmPriorityToLetter(priority) {
    if (priority === undefined || priority === null || Number.isNaN(priority))
        return undefined;
    const clamped = Math.max(0, Math.min(4, Math.trunc(priority)));
    return String.fromCharCode(65 + clamped);
}
/**
 * Parse a single todo.txt line into a structured item. Returns null for blank
 * lines (which carry no task).
 */
export function parseTodoTxtLine(line) {
    let rest = line.trim();
    if (rest === "")
        return null;
    let done = false;
    let completionDate;
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
    let priorityLetter;
    const prioMatch = /^\(([A-Z])\)\s+(.*)$/.exec(rest);
    if (prioMatch) {
        priorityLetter = prioMatch[1];
        rest = prioMatch[2].trim();
    }
    // Optional creation date (a leading bare date after the priority).
    let creationDate;
    const createMatch = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(rest);
    if (createMatch) {
        creationDate = createMatch[1];
        rest = createMatch[2].trim();
    }
    const projects = [];
    const contexts = [];
    const kv = {};
    let due;
    const words = rest.split(/\s+/);
    const textWords = [];
    for (const w of words) {
        if (w.length > 1 && w[0] === "+") {
            projects.push(w.slice(1));
        }
        else if (w.length > 1 && w[0] === "@") {
            contexts.push(w.slice(1));
        }
        else if (/^[^\s:]+:[^\s:]+$/.test(w)) {
            const idx = w.indexOf(":");
            const key = w.slice(0, idx);
            const val = w.slice(idx + 1);
            if (key === "due")
                due = val;
            else
                kv[key] = val;
        }
        else {
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
export function parseTodoTxt(content) {
    const out = [];
    for (const line of content.split("\n")) {
        const item = parseTodoTxtLine(line);
        if (item)
            out.push(item);
    }
    return out;
}
/**
 * Serialize a single pm item to a todo.txt line. `+project`/`@context` are
 * derived from tags (todo.txt has no separate notion), `due:` from deadline.
 */
export function serializeTodoTxtLine(item) {
    const parts = [];
    const done = mapPmStatusToChecked(item.status);
    if (done)
        parts.push("x");
    // Completion date follows the `x` marker (todo.txt: `x <completion> …`).
    // Only meaningful for done items.
    if (done && item.completionDate && DATE_RE.test(item.completionDate)) {
        parts.push(item.completionDate);
    }
    const letter = pmPriorityToLetter(item.priority);
    if (letter && !done)
        parts.push(`(${letter})`);
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
        if (DATE_RE.test(date))
            parts.push(`due:${date}`);
    }
    // Arbitrary key:value metadata preserved verbatim (sorted for stable output).
    if (item.kv) {
        for (const key of Object.keys(item.kv).sort()) {
            const val = item.kv[key];
            if (val !== undefined && val !== "")
                parts.push(`${key}:${val}`);
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
export function todoTxtItemToPm(item, id = "") {
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
export function serializeTodoTxt(items) {
    if (items.length === 0)
        return "";
    return items.map(serializeTodoTxtLine).join("\n") + "\n";
}
// ---------------------------------------------------------------------------
// pi coding-agent todo extension JSON state
// ---------------------------------------------------------------------------
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parsePiTodo(value, index) {
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
export function parsePiTodoDetails(content) {
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch (err) {
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
    const action = actionRaw === "list" || actionRaw === "add" || actionRaw === "toggle" || actionRaw === "clear"
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
export function extractTodojsonSourceId(description) {
    if (!description)
        return undefined;
    const match = TODOJSON_ID_MARKER_RE.exec(description);
    if (!match)
        return undefined;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
/**
 * Build the import provenance description used by todojson imports. Includes a
 * persisted `todo-id:<n>` marker so later exports can keep todo ids stable.
 */
export function buildTodojsonImportDescription(file, lineNumber, todoId) {
    const base = `Imported from ${file ?? "stdin"} line ${lineNumber}`;
    return todoId !== undefined ? `${base} (todo-id:${todoId})` : base;
}
/**
 * Decide whether an upserted todojson line should refresh an existing item's
 * description with the canonical import-provenance marker.
 */
function shouldRefreshTodojsonDescription(existingDescription, todoId) {
    if (!existingDescription)
        return true;
    const existingId = extractTodojsonSourceId(existingDescription);
    if (existingId !== undefined)
        return existingId !== todoId;
    return TODOJSON_IMPORTED_DESCRIPTION_RE.test(existingDescription);
}
function parseTimestamp(value) {
    if (!value)
        return Number.POSITIVE_INFINITY;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
export function serializePiTodoDetails(items) {
    const rows = items.map((item) => ({ item }));
    const usedIds = new Set();
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
        .sort((a, b) => parseTimestamp(a.item.created_at) - parseTimestamp(b.item.created_at)
        || parseTimestamp(a.item.updated_at) - parseTimestamp(b.item.updated_at)
        || (a.item.id ?? "").localeCompare(b.item.id ?? "")
        || (a.item.title ?? "").localeCompare(b.item.title ?? ""));
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
    const details = {
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
];
/**
 * Serialize pm items to JSON Lines (one compact JSON object per item, trailing NL).
 * Each row carries the full pm item payload so a jsonl round-trip is lossless
 * on every captured field (unlike markdown, which encodes only a subset).
 * Empty input returns the empty string (no rows, no trailing newline).
 */
export function serializeJsonl(items) {
    if (items.length === 0)
        return "";
    return (items
        .map((item) => {
        const row = {};
        for (const key of JSONL_KEYS) {
            const v = item[key];
            if (v === undefined || v === null)
                continue;
            if (Array.isArray(v) && v.length === 0)
                continue;
            if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
                continue;
            row[key] = v;
        }
        return JSON.stringify(row);
    })
        .join("\n") + "\n");
}
/**
 * Parse a JSON Lines document into pm items. Blank lines are skipped. Each
 * non-blank line MUST be a JSON object with at least a `title` string; `status`
 * defaults to "open" when absent. Other pm fields are passed through when
 * present, so a `serializeJsonl → parseJsonl` cycle is lossless. Throws a USAGE
 * CommandError on malformed JSON or a missing/empty title.
 */
export function parseJsonl(content) {
    const out = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "")
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch (err) {
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
        const item = {
            id: typeof parsed.id === "string" ? parsed.id : "",
            title,
            status,
        };
        // Pass through optional fields only when present and well-typed.
        if (typeof parsed.description === "string")
            item.description = parsed.description;
        if (typeof parsed.type === "string")
            item.type = parsed.type;
        if (typeof parsed.priority === "number")
            item.priority = parsed.priority;
        if (Array.isArray(parsed.tags))
            item.tags = parsed.tags.filter((t) => typeof t === "string");
        if (typeof parsed.deadline === "string")
            item.deadline = parsed.deadline;
        if (typeof parsed.assignee === "string")
            item.assignee = parsed.assignee;
        if (typeof parsed.sprint === "string")
            item.sprint = parsed.sprint;
        if (typeof parsed.created_at === "string")
            item.created_at = parsed.created_at;
        if (typeof parsed.updated_at === "string")
            item.updated_at = parsed.updated_at;
        if (typeof parsed.creationDate === "string")
            item.creationDate = parsed.creationDate;
        if (typeof parsed.completionDate === "string")
            item.completionDate = parsed.completionDate;
        if (isRecord(parsed.kv))
            item.kv = { ...parsed.kv };
        out.push(item);
    }
    return out;
}
/**
 * Group pm items for sectioned export. `status` (default) splits into Open
 * (open/in_progress/blocked/draft) and Done (closed/canceled), matching the
 * historical markdown layout. `sprint`/`type` group by that field value
 * (items missing the field land in an "(unassigned)" group, sorted last).
 */
export function groupItems(items, groupBy) {
    if (groupBy === "status") {
        const open = items.filter((i) => i.status === "open" || i.status === "in_progress" || i.status === "blocked" || i.status === "draft");
        const done = items.filter((i) => i.status === "closed" || i.status === "canceled");
        const groups = [];
        if (open.length)
            groups.push({ heading: "Open", items: open });
        if (done.length)
            groups.push({ heading: "Done", items: done });
        return groups;
    }
    const key = (i) => {
        const v = i[groupBy];
        return v === undefined || v === null || v === "" ? "(unassigned)" : String(v);
    };
    const buckets = new Map();
    for (const item of items) {
        const k = key(item);
        if (!buckets.has(k))
            buckets.set(k, []);
        buckets.get(k).push(item);
    }
    const headings = [...buckets.keys()].sort((a, b) => {
        if (a === "(unassigned)")
            return 1;
        if (b === "(unassigned)")
            return -1;
        return a.localeCompare(b);
    });
    return headings.map((h) => ({ heading: h, items: buckets.get(h) }));
}
/**
 * Render pm items as a GitHub-flavored task list grouped into `## <heading>`
 * sections. Closed/canceled items become `- [x]`, everything else `- [ ]`.
 * A trailing `<!-- id -->` comment preserves the pm id for round-trips.
 */
export function renderTaskList(items, groupBy, metadata = false, priorityMap = "number") {
    const groups = groupItems(items, groupBy);
    const lines = [];
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
export function renderCheckboxMarkdown(items, metadata = false, priorityMap = "number") {
    const lines = [];
    for (const item of items) {
        const check = mapPmStatusToChecked(item.status) ? "x" : " ";
        lines.push(`- [${check}] ${item.title}${metadata ? markdownMetadataSuffix(item, priorityMap) : ""} <!-- ${item.id} -->`);
    }
    return lines.length === 0 ? "" : lines.join("\n") + "\n";
}
/**
 * Validate a todo file (markdown or todo.txt) and return structured issues.
 *   - errors (structural): bad date in `due:`, priority letter out of A..Z
 *   - warnings: lines that look like tasks but don't parse, empty titles
 * `format` selects the grammar; `markdown` validates checkbox lines, `todotxt`
 * validates todo.txt lines.
 */
export function validateTodoFile(content, format) {
    const issues = [];
    let taskCount = 0;
    const lines = content.split("\n");
    if (format === "todojson") {
        try {
            const details = parsePiTodoDetails(content);
            const seen = new Set();
            for (const todo of details.todos) {
                taskCount++;
                if (seen.has(todo.id)) {
                    issues.push({ line: 0, severity: "error", message: `Duplicate todo id '${todo.id}'`, text: String(todo.id) });
                }
                seen.add(todo.id);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            issues.push({ line: 0, severity: "error", message: msg, text: "" });
        }
        return { issues, taskCount };
    }
    if (format === "jsonl") {
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            if (raw.trim() === "")
                continue;
            try {
                const parsed = JSON.parse(raw);
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
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                issues.push({ line: i + 1, severity: "error", message: `Invalid JSON: ${msg}`, text: raw.trim() });
            }
        }
        return { issues, taskCount };
    }
    if (format === "todotxt") {
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            if (raw.trim() === "")
                continue;
            const item = parseTodoTxtLine(raw);
            if (!item)
                continue;
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
export function preflightValidateImportFiles(files, format) {
    for (const file of files) {
        let content;
        try {
            content = readFileSync(file, "utf-8");
        }
        catch (err) {
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
            throw new CommandError(`Preflight: ${errors.length} structural error(s) in ${file} — import aborted before any items were created.\n` +
                `${detail}\n` +
                `Fix the file (or run \`pm todos validate ${file}\`) and re-import.`, EXIT_CODE.GENERIC_FAILURE);
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
function globToRegExp(glob) {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === "*") {
            if (glob[i + 1] === "*") {
                // `**` matches across directory separators
                re += ".*";
                i++;
                if (glob[i + 1] === "/")
                    i++; // swallow the trailing slash of `**/`
            }
            else {
                re += "[^/]*";
            }
        }
        else if (ch === "?") {
            re += "[^/]";
        }
        else if (".+^${}()|[]\\".includes(ch)) {
            re += "\\" + ch;
        }
        else {
            re += ch;
        }
    }
    return new RegExp("^" + re + "$");
}
/**
 * Resolve a `--glob <pattern>` into a sorted list of absolute file paths.
 * Walks the working directory (capped depth) and matches relative paths.
 */
function resolveGlob(pattern, cwd) {
    const re = globToRegExp(pattern);
    const out = [];
    const walk = (dir, depth) => {
        if (depth > 12)
            return;
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry === "node_modules" || entry === ".git" || entry === "dist")
                continue;
            const abs = join(dir, entry);
            let st;
            try {
                st = statSync(abs);
            }
            catch {
                continue;
            }
            if (st.isDirectory()) {
                walk(abs, depth + 1);
            }
            else if (st.isFile()) {
                const rel = relative(cwd, abs).split(sep).join("/");
                if (re.test(rel))
                    out.push(abs);
            }
        }
    };
    walk(cwd, 0);
    return out.sort();
}
/**
 * Read+parse one file into normalized todos for either supported format. For
 * todo.txt, `+project`/`@context` become tags and `due:` becomes the deadline.
 */
function parseFileToNormalized(md, file, format) {
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
            text: item.title,
            priority: item.priority,
            tags: item.tags ?? [],
            deadline: item.deadline,
            indent: 0,
            lineNumber: i + 1,
            file,
            pmId: item.id || undefined,
            itemType: item.type,
        }));
    }
    if (format === "todotxt") {
        const lines = md.split("\n");
        const out = [];
        for (let i = 0; i < lines.length; i++) {
            const item = parseTodoTxtLine(lines[i]);
            if (!item)
                continue;
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
export function todoSignatureKey(title, section) {
    const t = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (!t)
        return undefined;
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
export function buildExistingTodoIndex(items) {
    const byId = new Map();
    const bySig = new Map();
    for (const item of items) {
        if (!item.id)
            continue;
        const entry = {
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
        if (sigNoSection && !bySig.has(sigNoSection))
            bySig.set(sigNoSection, entry);
    }
    return { byId, bySig };
}
/** Pull the created item id out of `pm --json create` output (shape varies). */
export function extractCreatedTodoId(stdout) {
    try {
        const j = JSON.parse(stdout);
        return j?.id || j?.item?.id || j?.result?.id;
    }
    catch {
        return undefined;
    }
}
/** Fetch current workspace items via `pm list-all --json` (for the upsert index). */
function readPmItemsForUpsert(pmRoot) {
    const result = spawnSync("pm", ["--path", pmRoot, "--json", "list-all", "--limit", "10000"], { encoding: "utf-8" });
    if (result.status !== 0) {
        throw new CommandError(result.stderr || "pm list-all failed (needed for --upsert)");
    }
    try {
        const parsed = JSON.parse(result.stdout);
        const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.results ?? [];
        return items;
    }
    catch {
        throw new CommandError("Could not parse `pm list-all --json` output (needed for --upsert).");
    }
}
/**
 * Read, parse and (unless dry-run) create pm items for every TODO found across
 * the given files. Single code path shared by the command and the importer.
 */
function runTodoImport(opts) {
    let imported = 0;
    let skipped = 0;
    let updated = 0;
    const previews = [];
    // With --upsert, build the lookup indexes once up front (also in dry-run so
    // the preview reports create vs. update accurately). Without --upsert these
    // stay empty and every item is created — the unchanged historical behaviour.
    const index = opts.upsert
        ? buildExistingTodoIndex(readPmItemsForUpsert(opts.pmRoot))
        : { byId: new Map(), bySig: new Map() };
    // Resolve an incoming TODO to an existing item: prefer the embedded pm-id
    // comment (exact), then fall back to the title signature. A stored pm item
    // carries no reliable markdown section heading (the section becomes a
    // case-folded tag), so the fallback keys on the title alone — matching how
    // `buildExistingTodoIndex` builds `bySig`.
    const resolveExisting = (todo) => {
        if (!opts.upsert)
            return undefined;
        if (todo.pmId && index.byId.has(todo.pmId))
            return index.byId.get(todo.pmId);
        const sig = todoSignatureKey(todo.text);
        if (sig && index.bySig.has(sig))
            return index.bySig.get(sig);
        return undefined;
    };
    for (const file of opts.files) {
        let md;
        try {
            md = readFileSync(file, "utf-8");
        }
        catch (err) {
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
                const status = mapStatusToPm(t.checked, opts.closedAs, opts.openAs ?? "open");
                if (opts.statusFilter && status !== opts.statusFilter)
                    return false;
                if (opts.typeFilter) {
                    const resolvedType = t.itemType ?? opts.itemType;
                    if (resolvedType !== opts.typeFilter)
                        return false;
                }
                return true;
            });
        }
        for (const todo of todos) {
            const tags = [...opts.extraTags];
            // Per-item tags (todo.txt +project/@context) carry through.
            for (const t of todo.tags) {
                if (t && !tags.includes(t))
                    tags.push(t);
            }
            if (opts.sectionTags && todo.section) {
                const tag = sectionToTag(todo.section);
                if (tag && !tags.includes(tag))
                    tags.push(tag);
            }
            // CLI --priority wins; otherwise use the priority inferred from markers.
            const priority = opts.priority !== undefined && opts.priority !== ""
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
                console.error(`  [dry-run] ${action}${existing ? ` ${existing.pmId}` : ""} ${todo.checked ? "[x]" : "[ ]"} ${"  ".repeat(Math.floor(todo.indent / 2))}${todo.text}` +
                    (tags.length ? ` (tags: ${tags.join(",")})` : "") +
                    (priority !== undefined ? ` (p${priority})` : "") +
                    (todo.deadline ? ` (due: ${todo.deadline})` : ""));
                if (action === "update")
                    updated++;
                else
                    imported++;
                continue;
            }
            try {
                if (existing) {
                    // UPSERT: update the matched item in place rather than duplicating.
                    // Disambiguate a trailing bracket that is actually TITLE CONTENT from
                    // a real round-trip type tag, using the matched item's stored title.
                    const { title: updTitle, type: updType } = resolveUpsertTitleType(todo.text, todo.itemType, existing.title);
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
                    if (updType)
                        updArgs.push("--type", updType);
                    // Only set status when it actually changes. Re-sending a terminal
                    // status (closed/canceled) makes `pm update` require --force; omitting
                    // it keeps re-import idempotent without forcing a spurious re-close.
                    if (status !== existing.status)
                        updArgs.push("--status", status);
                    if (priority !== undefined && priority !== "")
                        updArgs.push("--priority", priority);
                    if (tags.length > 0)
                        updArgs.push("--tags", tags.join(",")); // --tags replaces
                    if (todo.deadline)
                        updArgs.push("--deadline", todo.deadline);
                    const todojsonTodoId = opts.format === "todojson" ? todo.todoId : undefined;
                    const todojsonDescription = todojsonTodoId !== undefined
                        ? buildTodojsonImportDescription(todo.file, todo.lineNumber, todojsonTodoId)
                        : undefined;
                    if (todojsonTodoId !== undefined && shouldRefreshTodojsonDescription(existing.description, todojsonTodoId)) {
                        updArgs.push("--description", todojsonDescription);
                    }
                    const result = spawnSync("pm", updArgs, { encoding: "utf-8" });
                    if (result.status !== 0) {
                        throw new Error(result.stderr || "pm update failed");
                    }
                    existing.status = status;
                    existing.title = updTitle;
                    if (todojsonDescription)
                        existing.description = todojsonDescription;
                    updated++;
                }
                else {
                    const isTodojson = opts.format === "todojson" && todo.todoId !== undefined;
                    const importDescription = buildTodojsonImportDescription(todo.file, todo.lineNumber, isTodojson ? todo.todoId : undefined);
                    const spawnArgs = [
                        "--path", opts.pmRoot,
                        ...(opts.upsert ? ["--json"] : []),
                        "create",
                        "--title", todo.text,
                        "--type", itemType,
                        "--status", status,
                        "--description", importDescription,
                    ];
                    if (priority !== undefined && priority !== "")
                        spawnArgs.push("--priority", priority);
                    if (tags.length > 0)
                        spawnArgs.push("--tags", tags.join(","));
                    if (todo.deadline)
                        spawnArgs.push("--deadline", todo.deadline);
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
                            const entry = {
                                pmId: createdId,
                                status,
                                title: todo.text,
                                description: importDescription,
                            };
                            index.byId.set(createdId, entry);
                            const sig = todoSignatureKey(todo.text);
                            if (sig && !index.bySig.has(sig))
                                index.bySig.set(sig, entry);
                        }
                    }
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`${todo.file}:${todo.lineNumber}: ${existing ? "update" : "create"} failed — ${msg}`);
                skipped++;
            }
        }
    }
    return { imported, skipped, updated, previews: opts.dryRun ? previews : undefined };
}
/** Fetch + filter pm items via `pm list-all --json`. */
function fetchPmItems(opts) {
    const result = spawnSync("pm", ["--path", opts.pmRoot, "list-all", "--json"], { encoding: "utf-8" });
    if (result.status !== 0) {
        throw new CommandError(result.stderr || "pm list-all failed");
    }
    let items = JSON.parse(result.stdout).items ?? [];
    if (opts.statusFilter)
        items = items.filter((i) => i.status === opts.statusFilter);
    if (opts.typeFilter)
        items = items.filter((i) => i.type === opts.typeFilter);
    if (opts.sort)
        items = sortItems(items, opts.sort);
    return items;
}
/**
 * Render the default-markdown TODO export. Kept byte-identical to the original
 * (the `# TODO` header, export-timestamp comment, `## Open`/`## Done` sections,
 * and the `[type]` annotation on open items) so existing behaviour is stable.
 * This is the path used when no `--group-by` (or `--group-by status`) is set.
 */
export function renderDefaultMarkdown(items, nowIso, metadata = false, priorityMap = "number") {
    const lines = [
        "# TODO",
        "",
        `<!-- Exported from pm-cli on ${nowIso} -->`,
        "",
    ];
    const openItems = items.filter((i) => i.status === "open" || i.status === "in_progress" || i.status === "blocked" || i.status === "draft");
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
export function renderGroupedMarkdown(items, groupBy, nowIso, metadata = false, priorityMap = "number") {
    const lines = [
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
function buildTodoMarkdown(opts) {
    const items = fetchPmItems(opts);
    if (items.length === 0)
        return { markdown: "", count: 0 };
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
export default defineExtension({
    name: "pm-todos",
    version: "2026.7.6-1",
    activate(api) {
        // -----------------------------------------------------------------------
        // Command: pm todos validate <file>
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "todos validate",
            description: "Parse a TODO file and report problems (unparseable checkbox lines, " +
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
                { long: "--json", description: "Emit a JSON report" },
            ],
            async run(ctx) {
                const format = readImportFormat(ctx.options);
                const asJson = readBoolOption(ctx.options, "json");
                const filePath = ctx.args[0];
                if (!filePath) {
                    throw new CommandError("Usage: pm todos validate <file> [--format markdown|todotxt|todojson|jsonl|checkbox] [--json]", EXIT_CODE.USAGE);
                }
                let content;
                try {
                    content = readFileSync(resolve(filePath), "utf-8");
                }
                catch (err) {
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
            description: "Return a compact TODO workspace context snapshot (counts + focused " +
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
            async run(ctx) {
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
            description: "Bidirectionally sync a TODO file with the pm store: import file " +
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
            flags: [
                { long: "--format", value_name: "fmt", description: "File format: markdown (default), todotxt, todojson, jsonl, or checkbox" },
                { long: "--type", value_name: "type", description: "Item type for newly created items (default: Task)" },
                { long: "--closed-as", value_name: "status", description: "Status for checked items (default: closed)" },
                { long: "--status", value_name: "status", description: "Status for open/unchecked items (default: open)" },
                { long: "--priority", value_name: "n", description: "Priority 0-4; overrides markers inferred from text" },
                { long: "--tags", value_name: "csv", description: "Comma-separated extra tags added to every imported item" },
                { long: "--section", value_name: "name", description: "Only sync the named markdown section" },
                { long: "--section-tags", description: "Derive a tag from each item's markdown section heading" },
                { long: "--group-by", value_name: "field", description: "Section the re-export by status (default) | sprint | type (markdown/tasklist only)" },
                { long: "--metadata", description: "Include (pN)/(A)..(E) and due:YYYY-MM-DD tokens in markdown/tasklist re-export" },
                { long: "--priority-map", value_name: "scheme", description: "Priority token scheme for markdown/tasklist re-export: number (default) | letter" },
                { long: "--filter", value_name: "expr", description: "Filter items by status/type on the re-export (e.g. status=open,type=Task)" },
                { long: "--dry-run", description: "Report what would change without writing to pm or the file" },
                { long: "--json", description: "Return a JSON result object" },
            ],
            async run(ctx) {
                const fileArg = (ctx.args && ctx.args[0]);
                const fileOpt = readStringOption(ctx.options, "file");
                if (!fileArg && !fileOpt) {
                    throw new CommandError("Usage: pm todos sync <file> [--format markdown|todotxt|todojson|jsonl|checkbox] [--dry-run]", EXIT_CODE.USAGE);
                }
                const filePath = resolve((fileArg ?? fileOpt));
                // A single --format drives both directions. `tasklist` is export-only
                // (no import grammar), so reject it explicitly with a clear message.
                const formatRaw = readStringOption(ctx.options, "format");
                if (formatRaw) {
                    const v = formatRaw.toLowerCase();
                    if (v === "tasklist" || v === "task-list" || v === "gfm") {
                        throw new CommandError("todos sync does not support --format tasklist (tasklist is export-only; use markdown, todotxt, todojson, jsonl, or checkbox)", EXIT_CODE.USAGE);
                    }
                }
                const importFormat = readImportFormat(ctx.options);
                const exportFormat = importFormat === "checkbox" ? "checkbox" : importFormat;
                const itemType = readStringOption(ctx.options, "type") ?? "Task";
                const closedAs = readStringOption(ctx.options, "closed-as", "closedAs") ?? "closed";
                const openAs = readStringOption(ctx.options, "status");
                const priority = readStringOption(ctx.options, "priority");
                const section = readStringOption(ctx.options, "section");
                const extraTags = (readStringOption(ctx.options, "tags") ?? "")
                    .split(",").map((t) => t.trim()).filter(Boolean);
                const sectionTags = ctx.options["sectionTags"] !== false && ctx.options["section-tags"] !== false;
                const dryRun = readBoolOption(ctx.options, "dry-run", "dryRun");
                const asJson = readBoolOption(ctx.options, "json");
                // Fail-fast syntax gate before any pm-store write.
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
                });
                // Re-export the reconciled pm state back to the same file. The export
                // honours --filter/--group-by/--metadata/--priority-map so the written
                // file matches the user's preferred layout. Under --dry-run nothing is
                // written to pm or disk; the export is computed only to report the
                // post-sync row count.
                const filter = readExportFilter(ctx.options);
                const { markdown: reexport, count: exportCount } = buildTodoMarkdown({
                    statusFilter: filter.status,
                    typeFilter: filter.type,
                    pmRoot: ctx.pm_root,
                    format: exportFormat,
                    groupBy: readGroupBy(ctx.options),
                    sort: readSort(ctx.options),
                    metadata: readBoolOption(ctx.options, "metadata", "include-metadata", "includeMetadata"),
                    priorityMap: readPriorityMap(ctx.options),
                });
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
                    console.error(`[dry-run] sync ${filePath}: import ${importResult.imported}, update ${importResult.updated ?? 0}, skip ${importResult.skipped}, re-export ${exportCount} item(s).`);
                    return asJson ? { ...result, previews: importResult.previews } : { ...result, previews: importResult.previews };
                }
                if (exportCount === 0) {
                    console.error(`sync: imported ${importResult.imported} item(s); no items to write back (file left unchanged).`);
                }
                else {
                    writeFileSync(filePath, reexport, "utf-8");
                    console.error(`sync: imported ${importResult.imported}, updated ${importResult.updated ?? 0}, skipped ${importResult.skipped}; wrote ${exportCount} item(s) back to ${filePath}.`);
                }
                return asJson ? result : result;
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
        api.registerImporter("todos", async (ctx) => {
            const dryRun = readBoolOption(ctx.options, "dry-run", "dryRun");
            const glob = readStringOption(ctx.options, "glob");
            const fileArg = (ctx.args && ctx.args[0]);
            const fileOpt = readStringOption(ctx.options, "file");
            let files;
            if (glob) {
                files = resolveGlob(glob, process.cwd());
                if (files.length === 0 && ctx.pm_root) {
                    files = resolveGlob(glob, resolve(ctx.pm_root, ".."));
                }
                if (files.length === 0) {
                    throw new CommandError(`No files matched glob: ${glob}`, EXIT_CODE.NOT_FOUND);
                }
                console.error(`Matched ${files.length} file(s) for glob '${glob}'.`);
            }
            else if (fileArg || fileOpt) {
                files = [resolve((fileArg ?? fileOpt))];
            }
            else {
                throw new CommandError("Usage: pm todos import <file> [--glob <pattern>] [--section <name>] [--closed-as <status>] [--dry-run]", EXIT_CODE.USAGE);
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
        api.registerExporter("todos", async (ctx) => {
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
        });
        // -----------------------------------------------------------------------
        // Importer: todos-import  (legacy alias — retained for backward compat)
        // -----------------------------------------------------------------------
        api.registerImporter("todos-import", async (ctx) => {
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
        api.registerPreflight((ctx) => {
            const d = ctx?.decision ?? {};
            const passthrough = {
                enforce_item_format_gate: d.enforce_item_format_gate ?? true,
                run_preflight_item_format_sync: d.run_preflight_item_format_sync ?? false,
                run_extension_migrations: d.run_extension_migrations ?? true,
                enforce_mandatory_migration_gate: d.enforce_mandatory_migration_gate ?? false,
            };
            // Scope strictly to the import command; never touch export/validate.
            if (ctx?.command !== "todos import")
                return passthrough;
            // Resolve the input file(s) exactly as the import handler does.
            const glob = readStringOption(ctx.options ?? {}, "glob");
            const fileArg = (ctx.args && ctx.args[0]);
            const fileOpt = readStringOption(ctx.options ?? {}, "file");
            let files = [];
            if (glob) {
                files = resolveGlob(glob, process.cwd());
                if (files.length === 0 && ctx.pm_root) {
                    files = resolveGlob(glob, resolve(ctx.pm_root, ".."));
                }
            }
            else if (fileArg || fileOpt) {
                files = [resolve((fileArg ?? fileOpt))];
            }
            if (files.length === 0)
                return passthrough; // usage error surfaces in the handler
            const format = readImportFormat(ctx.options ?? {});
            // Best-effort early gate. The handler re-runs (and enforces) the same
            // check, so even though a throw here is swallowed by the runtime, the
            // import still fails fast with no partial write.
            preflightValidateImportFiles(files, format);
            return passthrough;
        });
    },
});
//# sourceMappingURL=index.js.map