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
    throw new CommandError(`Unknown --format '${raw}' (expected markdown|todotxt)`, EXIT_CODE.USAGE);
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
    throw new CommandError(`Unknown --format '${raw}' (expected markdown|todotxt|tasklist)`, EXIT_CODE.USAGE);
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
function parseMarkdownTodos(md, file) {
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
            const { text, priority } = extractPriority(raw);
            todos.push({
                indent: match[1].replace(/\t/g, "    ").length,
                checked: match[2] !== " ",
                text,
                priority,
                section: currentSection,
                lineNumber: i + 1,
                file,
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
function mapStatusToPm(checked, closedAs) {
    return checked ? closedAs : "open";
}
function mapPmStatusToChecked(status) {
    return status === "closed" || status === "canceled";
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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
    const letter = pmPriorityToLetter(item.priority);
    if (letter && !done)
        parts.push(`(${letter})`);
    parts.push(item.title);
    for (const tag of item.tags ?? []) {
        parts.push(`+${tag}`);
    }
    if (item.deadline) {
        const date = item.deadline.slice(0, 10);
        if (DATE_RE.test(date))
            parts.push(`due:${date}`);
    }
    return parts.join(" ");
}
/**
 * Serialize pm items to a todo.txt document (one line per item, trailing NL).
 */
export function serializeTodoTxt(items) {
    if (items.length === 0)
        return "";
    return items.map(serializeTodoTxtLine).join("\n") + "\n";
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
export function renderTaskList(items, groupBy) {
    const groups = groupItems(items, groupBy);
    const lines = [];
    for (const group of groups) {
        lines.push(`## ${group.heading}`, "");
        for (const item of group.items) {
            const check = mapPmStatusToChecked(item.status) ? "x" : " ";
            lines.push(`- [${check}] ${item.title} <!-- ${item.id} -->`);
        }
        lines.push("");
    }
    return lines.join("\n").trimEnd() + "\n";
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
            if (text === "") {
                issues.push({ line: i + 1, severity: "warning", message: "Checkbox has no text", text: raw.trim() });
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
    return parseMarkdownTodos(md, file).map((t) => ({
        checked: t.checked,
        text: t.text,
        priority: t.priority,
        tags: [],
        section: t.section,
        indent: t.indent,
        lineNumber: t.lineNumber,
        file: t.file,
    }));
}
/**
 * Read, parse and (unless dry-run) create pm items for every TODO found across
 * the given files. Single code path shared by the command and the importer.
 */
function runTodoImport(opts) {
    let imported = 0;
    let skipped = 0;
    const previews = [];
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
            const status = mapStatusToPm(todo.checked, opts.closedAs);
            if (opts.dryRun) {
                previews.push({
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
                console.error(`  [dry-run] ${todo.checked ? "[x]" : "[ ]"} ${"  ".repeat(Math.floor(todo.indent / 2))}${todo.text}` +
                    (tags.length ? ` (tags: ${tags.join(",")})` : "") +
                    (priority !== undefined ? ` (p${priority})` : "") +
                    (todo.deadline ? ` (due: ${todo.deadline})` : ""));
                imported++;
                continue;
            }
            try {
                const spawnArgs = [
                    "--path", opts.pmRoot,
                    "create",
                    "--title", todo.text,
                    "--type", opts.itemType,
                    "--status", status,
                    "--description", `Imported from ${todo.file ?? "stdin"} line ${todo.lineNumber}`,
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
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`${todo.file}:${todo.lineNumber}: create failed — ${msg}`);
                skipped++;
            }
        }
    }
    return { imported, skipped, previews: opts.dryRun ? previews : undefined };
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
    return items;
}
/**
 * Render the default-markdown TODO export. Kept byte-identical to the original
 * (the `# TODO` header, export-timestamp comment, `## Open`/`## Done` sections,
 * and the `[type]` annotation on open items) so existing behaviour is stable.
 * This is the path used when no `--group-by` (or `--group-by status`) is set.
 */
export function renderDefaultMarkdown(items, nowIso) {
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
            const typeTag = item.type ? ` [${item.type}]` : "";
            lines.push(`- [${check}] ${item.title}${typeTag} <!-- ${item.id} -->`);
        }
        lines.push("");
    }
    if (closedItems.length > 0) {
        lines.push("## Done", "");
        for (const item of closedItems) {
            lines.push(`- [x] ${item.title} <!-- ${item.id} -->`);
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
export function renderGroupedMarkdown(items, groupBy, nowIso) {
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
            lines.push(`- [${check}] ${item.title} <!-- ${item.id} -->`);
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
    if (format === "todotxt") {
        return { markdown: serializeTodoTxt(items), count: items.length };
    }
    if (format === "tasklist") {
        return { markdown: renderTaskList(items, groupBy ?? "status"), count: items.length };
    }
    // markdown
    if (groupBy && groupBy !== "status") {
        return { markdown: renderGroupedMarkdown(items, groupBy, new Date().toISOString()), count: items.length };
    }
    return { markdown: renderDefaultMarkdown(items, new Date().toISOString()), count: items.length };
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default defineExtension({
    name: "pm-todos",
    version: "2026.6.3",
    activate(api) {
        // -----------------------------------------------------------------------
        // Command: pm todos import <file>
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "todos import",
            description: "Import markdown TODO items (- [ ] and - [x]) as pm items. " +
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
                "pm todos import todo.txt --format todotxt",
            ],
            flags: [
                { long: "--dry-run", description: "Preview without writing" },
                { long: "--format", value_name: "fmt", description: "Source format: markdown (default) | todotxt" },
                { long: "--type", value_name: "type", description: "Item type for imported items (default: Task)" },
                { long: "--priority", value_name: "n", description: "Priority for imported items (0-4); overrides inferred markers" },
                { long: "--tags", value_name: "tags", description: "Comma-separated tags to apply to all items" },
                { long: "--glob", value_name: "pattern", description: "Import every markdown file matching this glob (e.g. 'docs/**/*.md')" },
                { long: "--section", value_name: "name", description: "Import only items under this ## section heading" },
                { long: "--closed-as", value_name: "status", description: "Status to assign checked items (default: closed)" },
                { long: "--no-section-tags", description: "Do not derive tags from section headings" },
            ],
            async run(ctx) {
                const dryRun = readBoolOption(ctx.options, "dry-run", "dryRun");
                const format = readImportFormat(ctx.options);
                const itemType = ctx.options["type"] || "Task";
                const priority = ctx.options["priority"];
                const tagsOpt = ctx.options["tags"];
                const glob = readStringOption(ctx.options, "glob");
                const section = readStringOption(ctx.options, "section");
                const closedAs = readStringOption(ctx.options, "closed-as", "closedAs") ?? "closed";
                // `--no-section-tags` arrives as sectionTags=false; default on.
                const sectionTags = ctx.options["sectionTags"] !== false && ctx.options["section-tags"] !== false;
                let files;
                if (glob) {
                    files = resolveGlob(glob, process.cwd());
                    if (files.length === 0) {
                        throw new CommandError(`No files matched glob: ${glob}`, EXIT_CODE.NOT_FOUND);
                    }
                    console.error(`Matched ${files.length} file(s) for glob '${glob}'.`);
                }
                else {
                    const filePath = ctx.args[0];
                    if (!filePath) {
                        throw new CommandError("Usage: pm todos import <file> [--glob <pattern>] [--section <name>] [--closed-as <status>] [--dry-run]", EXIT_CODE.USAGE);
                    }
                    files = [resolve(filePath)];
                }
                const extraTags = (tagsOpt ?? "").split(",").map((t) => t.trim()).filter(Boolean);
                const { imported, skipped, previews } = runTodoImport({
                    files,
                    itemType,
                    closedAs,
                    priority,
                    extraTags,
                    section,
                    sectionTags,
                    dryRun,
                    pmRoot: ctx.pm_root,
                    format,
                });
                if (imported === 0 && skipped === 0) {
                    console.error("No TODO items found.");
                    return { imported: 0, skipped: 0 };
                }
                if (dryRun) {
                    console.error(`[dry-run] Would import ${imported} TODO item(s), skip ${skipped}.`);
                    return { dryRun: true, wouldImport: imported, wouldSkip: skipped, previews };
                }
                console.error(`Imported ${imported} TODO item(s), skipped ${skipped}.`);
                return { imported, skipped };
            },
        });
        // -----------------------------------------------------------------------
        // Command: pm todos export
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "todos export",
            description: "Export pm items as a markdown TODO list, todo.txt, or GitHub task list. " +
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
            ],
            flags: [
                { long: "--output", value_name: "file", description: "Write output to file (default: stdout)" },
                { long: "--format", value_name: "fmt", description: "Output format: markdown (default) | todotxt | tasklist" },
                { long: "--group-by", value_name: "field", description: "Section markdown/tasklist by status (default) | sprint | type" },
                { long: "--status", value_name: "status", description: "Filter by status" },
                { long: "--type", value_name: "type", description: "Filter by item type" },
            ],
            async run(ctx) {
                const outputPath = ctx.options["output"];
                const format = readExportFormat(ctx.options);
                const groupBy = readGroupBy(ctx.options);
                console.error("Fetching pm items…");
                const { markdown, count } = buildTodoMarkdown({
                    statusFilter: ctx.options["status"],
                    typeFilter: ctx.options["type"],
                    pmRoot: ctx.pm_root,
                    format,
                    groupBy,
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
            description: "Parse a TODO file and report problems (unparseable checkbox lines, " +
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
            async run(ctx) {
                const format = readImportFormat(ctx.options);
                const asJson = readBoolOption(ctx.options, "json");
                const filePath = ctx.args[0];
                if (!filePath) {
                    throw new CommandError("Usage: pm todos validate <file> [--format markdown|todotxt] [--json]", EXIT_CODE.USAGE);
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
            const priority = readStringOption(ctx.options, "priority");
            const section = readStringOption(ctx.options, "section");
            const extraTags = (readStringOption(ctx.options, "tags") ?? "")
                .split(",").map((t) => t.trim()).filter(Boolean);
            const sectionTags = ctx.options["sectionTags"] !== false && ctx.options["section-tags"] !== false;
            const format = readImportFormat(ctx.options);
            const { imported, skipped, previews } = runTodoImport({
                files,
                itemType,
                closedAs,
                priority,
                extraTags,
                section,
                sectionTags,
                dryRun,
                pmRoot: ctx.pm_root,
                format,
            });
            if (imported === 0 && skipped === 0) {
                console.error("No TODO items found.");
                return { imported: 0, skipped: 0 };
            }
            if (dryRun) {
                console.error(`[dry-run] Would import ${imported} TODO item(s), skip ${skipped}.`);
                return { dryRun: true, wouldImport: imported, wouldSkip: skipped, previews };
            }
            console.error(`Imported ${imported} TODO item(s), skipped ${skipped}.`);
            return { imported, skipped };
        });
        // -----------------------------------------------------------------------
        // Exporter: todos  (native `pm export todos` pipeline)
        //
        // Mirrors the `todos export` command so markdown is a first-class
        // import/export pair. Writes to `--output` or prints to stdout.
        // -----------------------------------------------------------------------
        api.registerExporter("todos", async (ctx) => {
            const outputPath = readStringOption(ctx.options, "output");
            const { markdown, count } = buildTodoMarkdown({
                statusFilter: readStringOption(ctx.options, "status"),
                typeFilter: readStringOption(ctx.options, "type"),
                pmRoot: ctx.pm_root,
                format: readExportFormat(ctx.options),
                groupBy: readGroupBy(ctx.options),
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
        api.registerImporter("todos-import", async (ctx) => {
            const filePath = readStringOption(ctx.options, "file");
            if (!filePath) {
                console.error("todos-import: no 'file' provided — skipping.");
                return;
            }
            const closedAs = readStringOption(ctx.options, "closed-as", "closedAs") ?? "closed";
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
    },
});
//# sourceMappingURL=index.js.map