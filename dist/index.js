// pm-todos — Markdown TODO round-trip for pm-cli
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const defineExtension = ((extension) => extension);
// ---------------------------------------------------------------------------
// Markdown TODO parser
// ---------------------------------------------------------------------------
const TODO_RE = /^(\s*)- \[([ xX])\] (.+)$/;
function parseMarkdownTodos(md) {
    const lines = md.split("\n");
    const todos = [];
    for (let i = 0; i < lines.length; i++) {
        const match = TODO_RE.exec(lines[i]);
        if (match) {
            todos.push({
                indent: match[1].length,
                checked: match[2] !== " ",
                text: match[3].trim(),
                lineNumber: i + 1,
            });
        }
    }
    return todos;
}
function mapStatusToPm(checked) {
    return checked ? "closed" : "open";
}
function mapPmStatusToChecked(status) {
    return status === "closed" || status === "canceled";
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default defineExtension({
    name: "pm-todos",
    version: "0.1.0",
    activate(api) {
        // -----------------------------------------------------------------------
        // Command: pm todos import <file>
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "todos import",
            description: "Import markdown TODO items (- [ ] and - [x]) as pm items. " +
                "Each checkbox becomes a pm Task; checked items are closed.",
            intent: "import markdown checkboxes as pm items",
            examples: [
                "pm todos import TODO.md",
                "pm todos import notes.md --dry-run",
                "pm todos import backlog.md --type Task",
            ],
            flags: [
                { long: "--dry-run", description: "Preview without writing" },
                { long: "--type", value_name: "type", description: "Item type for imported items (default: Task)" },
                { long: "--priority", value_name: "n", description: "Priority for imported items (0-4)" },
                { long: "--tags", value_name: "tags", description: "Comma-separated tags to apply" },
            ],
            async run(ctx) {
                const filePath = ctx.args[0];
                if (!filePath) {
                    console.error("Usage: pm todos import <file> [--dry-run] [--type Task]");
                    return { error: "No file path provided" };
                }
                const dryRun = Boolean(ctx.options["dry-run"]);
                const itemType = ctx.options["type"] || "Task";
                const priority = ctx.options["priority"];
                const tags = ctx.options["tags"];
                const absolutePath = resolve(filePath);
                console.error(`Parsing markdown TODOs from: ${absolutePath}`);
                let md;
                try {
                    md = readFileSync(absolutePath, "utf-8");
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`Failed to read file: ${msg}`);
                    return { error: msg };
                }
                const todos = parseMarkdownTodos(md);
                if (todos.length === 0) {
                    console.error("No TODO items found in file.");
                    return { imported: 0, skipped: 0 };
                }
                let imported = 0;
                let skipped = 0;
                for (const todo of todos) {
                    if (dryRun) {
                        console.error(`  [dry-run] ${todo.checked ? "[x]" : "[ ]"} ${todo.text}`);
                        imported++;
                        continue;
                    }
                    try {
                        const spawnArgs = [
                            "--path", ctx.pm_root,
                            "create",
                            "--title", todo.text,
                            "--type", itemType,
                            "--status", mapStatusToPm(todo.checked),
                            "--description", `Imported from ${filePath} line ${todo.lineNumber}`,
                        ];
                        if (priority)
                            spawnArgs.push("--priority", priority);
                        if (tags)
                            spawnArgs.push("--tags", tags);
                        const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
                        if (result.status !== 0) {
                            throw new Error(result.stderr || "pm create failed");
                        }
                        imported++;
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        console.error(`Line ${todo.lineNumber}: create failed — ${msg}`);
                        skipped++;
                    }
                }
                if (dryRun) {
                    console.error(`[dry-run] Would import ${imported} TODO item(s), skip ${skipped}.`);
                    return { dryRun: true, wouldImport: imported, wouldSkip: skipped };
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
                const statusFilter = ctx.options["status"];
                const typeFilter = ctx.options["type"];
                const spawnArgs = ["--path", ctx.pm_root, "list-all", "--json"];
                console.error("Fetching pm items…");
                const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
                if (result.status !== 0) {
                    const msg = result.stderr || "pm list-all failed";
                    console.error(msg);
                    return { error: msg };
                }
                let items = JSON.parse(result.stdout).items ?? [];
                if (statusFilter) {
                    items = items.filter((i) => i.status === statusFilter);
                }
                if (typeFilter) {
                    items = items.filter((i) => i.type === typeFilter);
                }
                if (items.length === 0) {
                    console.error("No items found.");
                    return { exported: 0 };
                }
                const lines = [
                    "# TODO",
                    "",
                    `<!-- Exported from pm-cli on ${new Date().toISOString()} -->`,
                    "",
                ];
                // Group: open first, then in_progress, then closed/canceled
                const openItems = items.filter((i) => i.status === "open" || i.status === "in_progress" || i.status === "blocked" || i.status === "draft");
                const closedItems = items.filter((i) => i.status === "closed" || i.status === "canceled");
                if (openItems.length > 0) {
                    lines.push("## Open");
                    lines.push("");
                    for (const item of openItems) {
                        const check = mapPmStatusToChecked(item.status) ? "x" : " ";
                        const typeTag = item.type ? ` [${item.type}]` : "";
                        lines.push(`- [${check}] ${item.title}${typeTag} <!-- ${item.id} -->`);
                    }
                    lines.push("");
                }
                if (closedItems.length > 0) {
                    lines.push("## Done");
                    lines.push("");
                    for (const item of closedItems) {
                        lines.push(`- [x] ${item.title} <!-- ${item.id} -->`);
                    }
                    lines.push("");
                }
                const markdown = lines.join("\n");
                if (outputPath) {
                    const absolutePath = resolve(outputPath);
                    writeFileSync(absolutePath, markdown, "utf-8");
                    console.error(`Exported ${items.length} item(s) to: ${absolutePath}`);
                    return { exported: items.length, file: absolutePath };
                }
                console.error(`Exported ${items.length} item(s).`);
                return { exported: items.length, markdown };
            },
        });
        // -----------------------------------------------------------------------
        // Importer: todos-import
        // -----------------------------------------------------------------------
        api.registerImporter("todos-import", async (ctx) => {
            const filePath = ctx.options["file"];
            if (!filePath) {
                console.error("todos-import: no 'file' provided — skipping.");
                return;
            }
            const absolutePath = resolve(filePath);
            console.error(`todos-import: reading ${absolutePath}`);
            let md;
            try {
                md = readFileSync(absolutePath, "utf-8");
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`todos-import: failed to read — ${msg}`);
                return;
            }
            const todos = parseMarkdownTodos(md);
            if (todos.length === 0) {
                console.error("todos-import: no TODO items found — skipping.");
                return;
            }
            let imported = 0;
            let skipped = 0;
            for (const todo of todos) {
                try {
                    const spawnArgs = [
                        "--path", ctx.pm_root,
                        "create",
                        "--title", todo.text,
                        "--type", "Task",
                        "--status", mapStatusToPm(todo.checked),
                    ];
                    const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
                    if (result.status !== 0) {
                        throw new Error(result.stderr || "pm create failed");
                    }
                    imported++;
                }
                catch (err) {
                    skipped++;
                }
            }
            console.error(`todos-import: done — imported ${imported}, skipped ${skipped}.`);
        });
    },
});
//# sourceMappingURL=index.js.map