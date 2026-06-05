interface TodoItem {
    checked: boolean;
    text: string;
    indent: number;
    lineNumber: number;
    /** Section header (`## …`) this item lives under, if any. Used as a tag. */
    section?: string;
    /** Priority inferred from `(p1)` / `!` markers (0 = highest). */
    priority?: number;
    /** Source file the item was parsed from (absolute path). */
    file?: string;
    /**
     * pm id parsed out of a trailing `<!-- pm-id -->` provenance comment (the same
     * comment the exporter emits). Lets `--upsert` re-import update the original
     * item instead of creating a duplicate. Undefined when no comment is present.
     */
    pmId?: string;
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
/**
 * Return a new, stably-sorted copy of `items` by the requested key:
 *   - priority: ascending (0 = highest first); missing priority sorts last
 *   - deadline: ascending ISO date; missing deadline sorts last
 *   - title:    case-insensitive alphabetical
 * Pure (does not mutate the input). Undefined `sort` returns the input as-is.
 */
export declare function sortItems(items: PmItem[], sort: "priority" | "deadline" | "title" | undefined): PmItem[];
/**
 * Strip a trailing `<!-- pm-id -->` comment from a TODO's text and return the
 * cleaned text plus the captured id. When there is no comment, `id` is
 * undefined and `text` is returned unchanged. Only the LAST trailing comment is
 * consumed (the exporter always emits exactly one, at end of line).
 */
export declare function extractPmIdComment(text: string): {
    text: string;
    id?: string;
};
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
export declare function parseMarkdownTodos(md: string, file?: string): TodoItem[];
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
/**
 * Map a todo.txt priority letter to a pm numeric priority.
 * todo.txt: `(A)` is highest. pm: `0` is highest.
 * `(A)`→0, `(B)`→1, … `(E)`→4. Letters beyond E (F..Z) clamp to 4 (lowest).
 * Returns undefined for an absent/invalid letter.
 */
export declare function priorityLetterToPm(letter: string | undefined): number | undefined;
/**
 * Map a pm numeric priority to a todo.txt priority letter.
 * `0`→`A`, `1`→`B`, … `4`→`E`. Out-of-range values clamp into A..E.
 * Returns undefined when priority is undefined.
 */
export declare function pmPriorityToLetter(priority: number | undefined): string | undefined;
/**
 * Parse a single todo.txt line into a structured item. Returns null for blank
 * lines (which carry no task).
 */
export declare function parseTodoTxtLine(line: string): TodoTxtItem | null;
/**
 * Parse a whole todo.txt document into structured items (blank lines skipped).
 */
export declare function parseTodoTxt(content: string): TodoTxtItem[];
/**
 * Serialize a single pm item to a todo.txt line. `+project`/`@context` are
 * derived from tags (todo.txt has no separate notion), `due:` from deadline.
 */
export declare function serializeTodoTxtLine(item: PmItem): string;
/**
 * Convert a parsed todo.txt item into the PmItem shape used by the serializer.
 * Preserves the structured fields (priority, projects/contexts as tags, due as
 * deadline, creation/completion dates, and arbitrary key:value metadata) so a
 * `parse → toPm → serialize` cycle is lossless on all captured fields. Used for
 * round-trip fidelity (and testing); not a pm persistence path.
 */
export declare function todoTxtItemToPm(item: TodoTxtItem, id?: string): PmItem;
/**
 * Serialize pm items to a todo.txt document (one line per item, trailing NL).
 */
export declare function serializeTodoTxt(items: PmItem[]): string;
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
export declare function groupItems(items: PmItem[], groupBy: string): ItemGroup[];
/**
 * Render pm items as a GitHub-flavored task list grouped into `## <heading>`
 * sections. Closed/canceled items become `- [x]`, everything else `- [ ]`.
 * A trailing `<!-- id -->` comment preserves the pm id for round-trips.
 */
export declare function renderTaskList(items: PmItem[], groupBy: string): string;
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
export declare function validateTodoFile(content: string, format: "markdown" | "todotxt"): {
    issues: ValidationIssue[];
    taskCount: number;
};
/**
 * Validate the syntax of every file about to be imported, BEFORE touching the
 * pm store. Throws a CommandError on the first file containing structural
 * errors (or an unreadable file). Returns silently when all files are clean.
 */
export declare function preflightValidateImportFiles(files: string[], format: "markdown" | "todotxt"): void;
/**
 * An existing pm item the upsert path may target. `status` is carried so the
 * update can omit `--status` when unchanged: re-sending a terminal status
 * (closed/canceled) makes `pm update` demand `--force`.
 */
export interface ExistingTodoItem {
    pmId: string;
    status?: string;
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
export declare function todoSignatureKey(title: string, section?: string): string | undefined;
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
export declare function buildExistingTodoIndex(items: PmItem[]): {
    byId: Map<string, ExistingTodoItem>;
    bySig: Map<string, ExistingTodoItem>;
};
/** Pull the created item id out of `pm --json create` output (shape varies). */
export declare function extractCreatedTodoId(stdout: string): string | undefined;
/**
 * Render the default-markdown TODO export. Kept byte-identical to the original
 * (the `# TODO` header, export-timestamp comment, `## Open`/`## Done` sections,
 * and the `[type]` annotation on open items) so existing behaviour is stable.
 * This is the path used when no `--group-by` (or `--group-by status`) is set.
 */
export declare function renderDefaultMarkdown(items: PmItem[], nowIso: string): string;
/**
 * Render grouped markdown for `--group-by sprint|type` (or an explicit
 * `--group-by status`). Each group is a `## <heading>` section of checkboxes
 * carrying the pm id comment for round-trips.
 */
export declare function renderGroupedMarkdown(items: PmItem[], groupBy: string, nowIso: string): string;
declare const _default: {
    name: string;
    version: string;
    activate(api: any): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map