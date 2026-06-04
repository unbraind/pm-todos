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