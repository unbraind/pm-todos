/** Seed an interrupted rollback through an installed artifact's public SDK, never a copied planner. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as CoreSdk from "@unbrained/pm-cli/sdk";
import type * as PackageSdk from "../index.ts";
import { interruptSourceRollback } from "./source-recovery-fixture.ts";

const [pmRoot, manifestPath, editingDirectory] = process.argv.slice(2);
const requireConsumer = createRequire(import.meta.url);
const core = requireConsumer("@unbrained/pm-cli/sdk") as typeof CoreSdk;
const api = requireConsumer("..") as Pick<typeof PackageSdk, "parseTodoSourceManifest" | "applyTodoSourceSelection">;
const manifest = api.parseTodoSourceManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
const files = manifest.sources.map(source => ({ file: source.file, text: readFileSync(join(editingDirectory, source.file), "utf8") }));
const result = await interruptSourceRollback(api.applyTodoSourceSelection, pmRoot, manifest, files, { sdk: core, point: "step_compensated" });
assert.equal(result.applied, 1);
const journal = JSON.parse(readFileSync(join(pmRoot, "transactions", "sdk", result.transaction + ".json"), "utf8")) as { status: string; startedStepIds: string[] };
assert.equal(journal.status, "compensating"); assert.equal(journal.startedStepIds.length, 1);
console.log(JSON.stringify({ interrupted: true, retained: result.applied, transaction: result.transaction }));
