# Weekly occurrence SDK example

Run this TypeScript from a project with `pm-todos` and its peer SDK installed.
Set `PM_PATH` to a tracker where pm-todos is active. Import a completed source
such as `x 2026-10-25 Weekly rec:+1w due:2026-10-20` using fidelity mapping.
Pass its pm id; add `--apply` only after reviewing the preview. The original
source is retained and the new Task is due on 2026-10-27.

```typescript
/** Preview first, then apply only the exact source revision reviewed by the caller. */
import { applyTodoOccurrence, previewTodoOccurrence } from "pm-todos";

const pmRoot = process.env.PM_PATH;
const id = process.argv[2];
if (!pmRoot || !id) throw new Error("Set PM_PATH to an initialized tracker with pm-todos active; pass the completed fidelity todo id.");
const input = { id, dialect: "todotxt-weekly-v1" as const };
const preview = await previewTodoOccurrence(pmRoot, input);
console.log(JSON.stringify(preview));
if (process.argv.includes("--apply") && preview.ok && preview.revision) {
  console.log(JSON.stringify(await applyTodoOccurrence(pmRoot, { ...input, expectedRevision: preview.revision }, { author: "recurrence-example" })));
}
```
