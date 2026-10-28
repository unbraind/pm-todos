/** Shared failure injection for real SDK, CLI and packed-consumer recovery acceptance. */
import assert from "node:assert/strict";
import type * as CoreSdk from "@unbrained/pm-cli/sdk";
import type { applyTodoSourceSelection, TodoSourceFile, TodoSourceManifest, TodoSourceSdk } from "../source-sessions.ts";

/** Every observable boundary of a native rollback, including each row position. */
export type SourceRollbackBoundary = "compensating" | "step_compensating" | "step_compensated" | "compensated";
/** An actual consumer SDK plus its native process-interruption diagnostic. */
export type SourceRecoverySdk = TodoSourceSdk & Pick<typeof CoreSdk, "WorkspaceTransactionInterruptedError">;
/** Force ordinary failure after all forward writes, then interrupt the chosen rollback boundary. */
export async function interruptSourceRollback(
  apply: typeof applyTodoSourceSelection, pmRoot: string, manifest: TodoSourceManifest, files: TodoSourceFile[],
  options: { sdk: SourceRecoverySdk; point: SourceRollbackBoundary; occurrence?: number; commit?: Parameters<typeof applyTodoSourceSelection>[3]["commit"] },
) {
  let failed = false, interrupted = false, observed = 0;
  const result = await apply(pmRoot, manifest, files, { author: "selection-test", sdk: options.sdk, commit: options.commit,
    onTransition(context) {
      if (context.transition === "committing" && !failed) { failed = true; throw new Error("Injected forward failure before commit"); }
      if (failed && context.transition === options.point && ++observed === (options.occurrence ?? 1)) {
        interrupted = true;
        throw new options.sdk.WorkspaceTransactionInterruptedError("Injected rollback interruption");
      }
    },
  });
  assert.equal(failed, true, "fixture must execute every forward write before rollback");
  assert.equal(interrupted, true, "fixture must reach the requested rollback boundary");
  assert.equal(result.ok, false);
  return result;
}
