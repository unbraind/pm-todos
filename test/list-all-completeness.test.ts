import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertListAllComplete, readItemsFromListAll } from "../index.ts";

/**
 * The non-row half of a real `pm list-all --json` envelope, captured verbatim
 * from pm-cli 2026.8.15 against a live two-item workspace.
 *
 * Captured rather than hand-written on purpose: an invented envelope only proves
 * the code agrees with the test author, and the shape of this receipt is exactly
 * what the assertions depend on.
 *
 * @param overrides - Fields to replace, one per incompleteness signal under test.
 * @returns An envelope object suitable for {@link assertListAllComplete}.
 */
function realListAllEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    count: 2,
    total: 2,
    has_more: false,
    truncated: false,
    next_cursor: null,
    completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
    filters: { status: "all", include_body: true, runtime_filters: {} },
    projection: { mode: "full", fields: null },
    sorting: { sort: "default", order: "asc" },
    now: "2026-08-15T11:48:21.518Z",
    omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] },
    ...overrides,
  };
}

test("a complete envelope is accepted", () => {
  assert.doesNotThrow(() => assertListAllComplete(realListAllEnvelope(), "the TODO export"));
});

test("a truncated row list is refused, naming the signal and the scale", () => {
  assert.throws(
    () => assertListAllComplete(realListAllEnvelope({ truncated: true, count: 10, total: 682 }), "the TODO export"),
    (err: Error) => /truncated/.test(err.message) && /10 of 682/.test(err.message) && /the TODO export/.test(err.message),
  );
});

test("rows past the returned page are refused", () => {
  assert.throws(
    () => assertListAllComplete(realListAllEnvelope({ has_more: true }), "the --upsert key index"),
    /more rows exist/,
  );
});

test("a partial completeness status is refused", () => {
  assert.throws(
    () => assertListAllComplete(
      realListAllEnvelope({ completeness: { status: "partial", unreadable_item_count: 3 } }),
      "the TODO export",
    ),
    /partial/,
  );
});

test("an absent completeness receipt is refused rather than assumed complete", () => {
  const envelope = realListAllEnvelope();
  delete envelope.completeness;
  assert.throws(() => assertListAllComplete(envelope, "the TODO export"), /absent/);
});

test("omitted field groups are refused", () => {
  assert.throws(
    () => assertListAllComplete(
      realListAllEnvelope({ omission_receipt: { has_omissions: true, omitted_field_group_count: 1 } }),
      "the TODO export",
    ),
    /omitted/,
  );
});

test("a bare array is accepted, since it carries no receipt to contradict", () => {
  assert.doesNotThrow(() => assertListAllComplete([{ id: "a-1" }], "the TODO export"));
});

// --- regressions from the first review round ------------------------------

test("the upsert refusal reaches the caller instead of being replaced by a parse error", () => {
  // The gate used to run inside the parse try/catch, whose bare `catch` replaced
  // the CommandError with "Could not parse". The refusal survived as a failure
  // but lost the signal name and the count-versus-total scale, which is the only
  // reason the gate produces a message at all.
  const truncated = realListAllEnvelope({ truncated: true, count: 10, total: 682 });
  assert.throws(
    () => assertListAllComplete(truncated, "the --upsert key index"),
    (err: Error) => /truncated/.test(err.message)
      && /10 of 682/.test(err.message)
      && !/Could not parse/.test(err.message),
  );
});

test("a bare array is read as the item list rather than yielding an empty export", () => {
  // A bare array is exempt from the gate, so the READER must handle that shape.
  // Reading `.items` off an array yields undefined and exported an EMPTY file
  // while reporting success — the silent-partial failure this change removes,
  // reintroduced one line below the gate that prevents it. Both readers now go
  // through readItemsFromListAll, so this asserts the real function.
  const bare = [{ id: "a-1", title: "A", status: "open" }];
  assert.doesNotThrow(() => assertListAllComplete(bare, "the TODO export"));
  assert.equal(readItemsFromListAll(bare).length, 1, "a bare array is the item list");
});

test("readItemsFromListAll handles every shape the readers can receive", () => {
  assert.deepEqual(readItemsFromListAll({ items: [{ id: "i-1" }] }).map((i) => i.id), ["i-1"]);
  assert.deepEqual(readItemsFromListAll({ results: [{ id: "r-1" }] }).map((i) => i.id), ["r-1"]);
  assert.deepEqual(readItemsFromListAll({}), [], "an envelope with neither key yields no rows");
  assert.deepEqual(readItemsFromListAll(null), [], "a null response yields no rows");
  assert.deepEqual(readItemsFromListAll("nonsense"), [], "a scalar response yields no rows");
  // A non-array under `items` must not be handed on as if it were rows: the
  // downstream code calls .filter/.map on it and would throw far from the cause.
  assert.deepEqual(readItemsFromListAll({ items: {} }), [], "a non-array items field yields no rows");
});

test("the manifest host floor matches the package peer floor", () => {
  // Two files tell two different audiences the same fact: package.json's
  // peerDependencies floor is read by npm, manifest.json's pm_min_version is
  // read by the pm host at install time. They drifted once already across this
  // fleet — a manifest still advertising 2026.7.28 while the code depended on a
  // receipt introduced in 2026.8.15 — and nothing detected it, because each file
  // is internally consistent. This binds them.
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as {
    pm_min_version?: string;
  };
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    peerDependencies?: Record<string, string>;
  };
  const peer = pkg.peerDependencies?.["@unbrained/pm-cli"] ?? "";
  assert.match(peer, /^>=\d+\.\d+\.\d+$/, "the peer declaration must be a concrete >= floor");
  assert.equal(
    manifest.pm_min_version,
    peer.replace(/^>=/, ""),
    "manifest.json pm_min_version must equal the package.json peer floor: they are the same claim to two different installers",
  );
});
