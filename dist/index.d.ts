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
/** Priority-rendering scheme for markdown/tasklist metadata tokens. */
type PriorityMapScheme = "number" | "letter";
/**
 * Parse a `--filter <expr>` option into discrete status/type predicates.
 * Accepts a comma-separated list of `key=value` or `key:value` pairs where the
 * only recognized keys are `status` and `type` (e.g. `status=open`,
 * `type:Task`, or `status=open,type=Task`). Repeated keys take the last value.
 * Returns undefined when no `--filter` option is present. Throws a USAGE
 * error on an unrecognised key so a typo like `--filter statis=open` fails
 * loudly instead of silently matching nothing.
 */
export declare function parseFilterExpression(raw: string | undefined): {
    status?: string;
    type?: string;
} | undefined;
/**
 * Return a new, stably-sorted copy of `items` by the requested key:
 *   - priority: ascending (0 = highest first); missing priority sorts last
 *   - deadline: ascending ISO date; missing deadline sorts last
 *   - title:    case-insensitive alphabetical
 * Pure (does not mutate the input). Undefined `sort` returns the input as-is.
 */
export declare function sortItems(items: PmItem[], sort: "priority" | "deadline" | "title" | undefined): PmItem[];
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
/**
 * Default focus ordering for `pm todos context`: active work first, then
 * urgency (priority/deadline), then recent updates.
 */
export declare function sortItemsForContext(items: PmItem[]): PmItem[];
/**
 * Build a compact, high-signal context payload for agents:
 * aggregate counts + a bounded focus list.
 */
export declare function buildTodoContextSnapshot(items: PmItem[], options: TodoContextBuildOptions): TodoContextSnapshot;
export declare function extractMarkdownDue(text: string): {
    text: string;
    deadline?: string;
};
/**
 * Strip a trailing `<!-- pm-id -->` comment from a TODO's text and return the
 * cleaned text plus the captured id. When there is no provenance comment, `id`
 * is undefined and `text` is returned unchanged (a non-id trailing comment is
 * left in the title verbatim). Only the LAST trailing comment is consumed (the
 * exporter always emits exactly one, at end of line).
 */
export declare function extractPmIdComment(text: string): {
    text: string;
    id?: string;
};
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
export declare function extractTypeTag(text: string): {
    text: string;
    type?: string;
};
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
export declare function resolveUpsertTitleType(parsedText: string, parsedType: string | undefined, existingTitle: string | undefined): {
    title: string;
    type?: string;
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
/**
 * Parse the todo extension's tool-result details payload. The canonical shape
 * mirrors upstream `todo.ts`: `{ action, todos, nextId }`. For convenience, a
 * raw `Todo[]` array is also accepted.
 */
export declare function parsePiTodoDetails(content: string): PiTodoDetails;
/**
 * Extract a persisted todojson source id (`todo-id:<n>`) from an item's
 * description, if present.
 */
export declare function extractTodojsonSourceId(description: string | undefined): number | undefined;
/**
 * Build the import provenance description used by todojson imports. Includes a
 * persisted `todo-id:<n>` marker so later exports can keep todo ids stable.
 */
export declare function buildTodojsonImportDescription(file: string | undefined, lineNumber: number, todoId?: number): string;
export declare function serializePiTodoDetails(items: PmItem[]): string;
/**
 * Serialize pm items to JSON Lines (one compact JSON object per item, trailing NL).
 * Each row carries the full pm item payload so a jsonl round-trip is lossless
 * on every captured field (unlike markdown, which encodes only a subset).
 * Empty input returns the empty string (no rows, no trailing newline).
 */
export declare function serializeJsonl(items: PmItem[]): string;
/**
 * Parse a JSON Lines document into pm items. Blank lines are skipped. Each
 * non-blank line MUST be a JSON object with at least a `title` string; `status`
 * defaults to "open" when absent. Other pm fields are passed through when
 * present, so a `serializeJsonl → parseJsonl` cycle is lossless. Throws a USAGE
 * CommandError on malformed JSON or a missing/empty title.
 */
export declare function parseJsonl(content: string): PmItem[];
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
export declare function renderTaskList(items: PmItem[], groupBy: string, metadata?: boolean, priorityMap?: PriorityMapScheme): string;
/**
 * Render pm items as a flat checkbox markdown list: one `- [ ]`/`- [x]` line
 * per item, each carrying a `<!-- id -->` provenance comment for round-trips.
 * Unlike the default markdown export, there is no `# TODO` header and no
 * `## Open`/`## Done` (or `--group-by`) sectioning — just the checkboxes. The
 * import grammar is identical to the default `markdown` parser, so a
 * `renderCheckboxMarkdown → parseMarkdownTodos` cycle is a clean round-trip.
 */
export declare function renderCheckboxMarkdown(items: PmItem[], metadata?: boolean, priorityMap?: PriorityMapScheme): string;
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
export declare function validateTodoFile(content: string, format: TodoImportFormat): {
    issues: ValidationIssue[];
    taskCount: number;
};
/**
 * Validate the syntax of every file about to be imported, BEFORE touching the
 * pm store. Throws a CommandError on the first file containing structural
 * errors (or an unreadable file). Returns silently when all files are clean.
 */
export declare function preflightValidateImportFiles(files: string[], format: TodoImportFormat): void;
/** Preserve an exact source status when available; checkbox-style formats
 * continue to map their binary checked state through --closed-as/--status. */
export declare function resolveImportedTodoStatus(sourceStatus: string | undefined, checked: boolean, closedAs: string, openAs?: string): string;
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
 * Apply the export `--sort` and `--reverse` ordering to a list of pm items.
 * Pure: returns a new array, never mutates the input. `--sort` orders ascending
 * (priority 0 first, earliest deadline first, alphabetical title); `--reverse`
 * then flips the order. The two flags compose: `--sort priority --reverse`
 * yields lowest-priority first. Without a sort key, reverse simply flips pm's
 * native `list-all` order. The input array is never returned or mutated.
 */
export declare function applyExportOrder(items: PmItem[], sort: "priority" | "deadline" | "title" | undefined, reverse: boolean | undefined): PmItem[];
/**
 * Render the default-markdown TODO export. Kept byte-identical to the original
 * (the `# TODO` header, export-timestamp comment, `## Open`/`## Done` sections,
 * and the `[type]` annotation on open items) so existing behaviour is stable.
 * This is the path used when no `--group-by` (or `--group-by status`) is set.
 */
export declare function renderDefaultMarkdown(items: PmItem[], nowIso: string, metadata?: boolean, priorityMap?: PriorityMapScheme): string;
/**
 * Render grouped markdown for `--group-by sprint|type` (or an explicit
 * `--group-by status`). Each group is a `## <heading>` section of checkboxes
 * carrying the pm id comment for round-trips.
 */
export declare function renderGroupedMarkdown(items: PmItem[], groupBy: string, nowIso: string, metadata?: boolean, priorityMap?: PriorityMapScheme): string;
declare const _default: {
    name: string;
    version: string;
    activate(api: any): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map