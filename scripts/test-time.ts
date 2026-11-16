/** Scale only harness watchdogs; reject invalid factors before starting any child. */
export function testTime(milliseconds: number, raw = process.env.PM_TEST_TIME_SCALE ?? "1"): number {
  const scale = Number(raw);
  const budget = Math.ceil(milliseconds * scale);
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isSafeInteger(budget) || budget <= 0 || budget > 2_147_483_647) {
    throw new Error("PM_TEST_TIME_SCALE must be finite, positive and within the timer range");
  }
  return budget;
}
