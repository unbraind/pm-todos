import assert from "node:assert/strict";
import test from "node:test";

import { assertListAllComplete } from "../index.ts";

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
