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
        let todos = parseMarkdownTodos(md, file);
        if (opts.section)
            todos = filterBySection(todos, opts.section);
        for (const todo of todos) {
            const tags = [...opts.extraTags];
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
                    section: todo.section,
                    indent: todo.indent,
                    file: todo.file,
                    line: todo.lineNumber,
                });
                console.error(`  [dry-run] ${todo.checked ? "[x]" : "[ ]"} ${"  ".repeat(Math.floor(todo.indent / 2))}${todo.text}` +
                    (tags.length ? ` (tags: ${tags.join(",")})` : "") +
                    (priority !== undefined ? ` (p${priority})` : ""));
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
function buildTodoMarkdown(opts) {
    const result = spawnSync("pm", ["--path", opts.pmRoot, "list-all", "--json"], { encoding: "utf-8" });
    if (result.status !== 0) {
        throw new CommandError(result.stderr || "pm list-all failed");
    }
    let items = JSON.parse(result.stdout).items ?? [];
    if (opts.statusFilter)
        items = items.filter((i) => i.status === opts.statusFilter);
    if (opts.typeFilter)
        items = items.filter((i) => i.type === opts.typeFilter);
    if (items.length === 0) {
        return { markdown: "", count: 0 };
    }
    const lines = [
        "# TODO",
        "",
        `<!-- Exported from pm-cli on ${new Date().toISOString()} -->`,
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
    return { markdown: lines.join("\n"), count: items.length };
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default defineExtension({
    name: "pm-todos",
    version: "2026.6.1",
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
            ],
            flags: [
                { long: "--dry-run", description: "Preview without writing" },
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
            description: "Export pm items as a markdown TODO list. " +
                "Open items become - [ ], closed/canceled items become - [x].",
            intent: "export pm items to markdown TODO format",
            examples: [
                "pm todos export",
                "pm todos export --output TODO.md",
                "pm todos export --status open --output backlog.md",
                "pm todos export --type Task",
            ],
            flags: [
                { long: "--output", value_name: "file", description: "Write markdown to file (default: stdout)" },
                { long: "--status", value_name: "status", description: "Filter by status" },
                { long: "--type", value_name: "type", description: "Filter by item type" },
            ],
            async run(ctx) {
                const outputPath = ctx.options["output"];
                console.error("Fetching pm items…");
                const { markdown, count } = buildTodoMarkdown({
                    statusFilter: ctx.options["status"],
                    typeFilter: ctx.options["type"],
                    pmRoot: ctx.pm_root,
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
            });
            console.error(`todos-import: done — imported ${imported}, skipped ${skipped}.`);
        });
    },
});
//# sourceMappingURL=index.js.map