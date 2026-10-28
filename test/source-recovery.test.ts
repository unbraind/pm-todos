/** Native-history recovery properties, independent of git and serialized output format. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as core from "@unbrained/pm-cli/sdk";
import { applyTodoSourceSelection as apply, exportTodoSourceSelection as checkout } from "../index.ts";
import { interruptSourceRollback, type SourceRollbackBoundary } from "../scripts/source-recovery-fixture.ts";

/** A real tracker with an unselected related row and no git executable on PATH. */
async function fixture(t: test.TestContext, count: number) {
  const root = mkdtempSync(join(tmpdir(), "todos-rollback-")), pmRoot = join(root, "tracker"), bin = join(root, "bin");
  mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  const previousPath = process.env.PATH, previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = bin; process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    rmSync(root, { recursive: true, force: true });
  });
  await core.init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
  const client = new core.PmClient({ pmRoot, cwd: root, author: "selection-test" });
  const statuses = ["recovery-review", "recovery-wait", "recovery-accepted", "recovery-retired"];
  if (count === 3) for (const [index, role] of [["active"], ["blocked"], ["terminal", "terminal_done"], ["terminal", "terminal_canceled"]].entries()) await client.schemaAddStatus(statuses[index], { role });
  const ids: string[] = [];
  for (let index = 0; index <= count; index++) {
    const created = await client.create({ id: `rollback-row-${index}`, title: `Original ${index}`, type: "Task", priority: index % 5,
      description: "Preserved native description", body: "Preserved native body", tags: "baseline", parent: index ? ids[0] : "none",
      sprint: "none", release: "none", dep: index ? [`id=${ids[index - 1]},kind=related`] : [],
      ...(count === 3 ? { status: statuses[index], ...(index > 1 ? { closeReason: "Seeded lifecycle evidence" } : {}) } : {}) });
    ids.push(created.item.id);
  }
  const selected = ids.slice(0, count);
  const exported = await checkout(pmRoot, { sources: ["one.txt", "two.txt"].map((file, index) => ({ file, ids: selected.filter((_, n) => n % 2 === index) })) });
  for (const file of exported.files) file.text = file.text.replaceAll("Original", "Edited");
  const bound = core.createExtensionCommandSdk(pmRoot, client, "selection-test");
  const commit = count === 3 ? (options: Parameters<NonNullable<Parameters<typeof apply>[3]["commit"]>>[0]) => bound.commitWorkspaceTransaction(options) : undefined;
  return { pmRoot, client, ids, selected, exported, commit };
}

for (const forged of ["compensation_values", "intervening_revision"] as const) {
  test(`rollback recovery rejects a matching marker with ${forged}`, async t => {
    const f = await fixture(t, 2);
    await interruptSourceRollback(apply, f.pmRoot, f.exported.manifest, f.exported.files, { sdk: core, point: "step_compensated" });
    const history = await core.readHistoryEntries(core.getHistoryPath(f.pmRoot, f.ids[0]), f.ids[0]);
    const compensate = history.at(-1)!.message!.replace(/:apply$/, ":compensate");
    if (forged === "intervening_revision") await f.client.update(f.ids[0], { description: "Intervening peer revision", message: "Foreign transition" });
    await f.client.update(f.ids[0], { title: "Peer title must survive", message: compensate });
    const before = await values(f);
    const refused = await apply(f.pmRoot, f.exported.manifest, f.exported.files, { author: "selection-test" });
    assert.equal(refused.ok, false); assert.equal(refused.refusals[0].code, "stale_revision");
    assert.deepEqual(await values(f), before);
  });
}
/** Compare complete item values read through the SDK; only native update time is volatile. */
async function values(f: Awaited<ReturnType<typeof fixture>>) {
  return Promise.all(f.ids.map(async id => {
    const item = (await f.client.get(id, { depth: "deep" })).item;
    const { updated_at, ...stable } = item;
    return stable;
  }));
}
/** Journal reads assert coordinator progress, never serve as an item-state oracle. */
function journal(pmRoot: string, transaction: string) {
  return JSON.parse(readFileSync(join(pmRoot, "transactions", "sdk", transaction + ".json"), "utf8")) as { status: string; startedStepIds: string[] };
}

for (const count of [2, 3]) {
  const cases: { point: SourceRollbackBoundary; occurrence: number }[] = [
    { point: "step_compensated", occurrence: 1 },
    { point: "compensating", occurrence: 1 },
    ...Array.from({ length: count }, (_, index) => ({ point: "step_compensating" as const, occurrence: index + 1 })),
    ...Array.from({ length: count - 1 }, (_, index) => ({ point: "step_compensated" as const, occurrence: index + 2 })),
    { point: "compensated", occurrence: 1 },
  ];
  for (const { point, occurrence } of cases) {
    test(`rollback recovery resumes ${point} ${occurrence} of ${count} rows`, async t => {
      const f = await fixture(t, count), before = await values(f);
      const originalHistory = f.ids.map(id => readFileSync(core.getHistoryPath(f.pmRoot, id), "utf8"));
      const crashed = await interruptSourceRollback(apply, f.pmRoot, f.exported.manifest, f.exported.files, { sdk: core, point, occurrence, commit: f.commit });
      assert.ok(crashed.transaction);
      assert.equal(journal(f.pmRoot, crashed.transaction).status, point === "compensated" ? "compensated" : "compensating");
      const interrupted = await values(f);
      const preview = await apply(f.pmRoot, f.exported.manifest, f.exported.files, { author: "selection-test", dryRun: true });
      assert.equal(preview.ok, true, JSON.stringify(preview));
      assert.deepEqual(await values(f), interrupted);
      const resumed = await apply(f.pmRoot, f.exported.manifest, f.exported.files, { author: "selection-test", commit: f.commit });
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      assert.equal(resumed.changed, preview.changed);
      assert.equal(journal(f.pmRoot, crashed.transaction).status, "committed");
      const after = await values(f);
      for (let index = 0; index < count; index++) {
        const { title, todos_todotxt, todos_source_file, ...rest } = after[index];
        const { title: baselineTitle, ...baseline } = before[index];
        assert.equal(title, `Edited ${index}`);
        assert.equal(todos_source_file, index % 2 === 0 ? "one.txt" : "two.txt");
        assert.deepEqual(rest, baseline);
        const history = await core.readHistoryEntries(core.getHistoryPath(f.pmRoot, f.ids[index]), f.ids[index]);
        assert.deepEqual(history.slice(1).map(entry => entry.message?.split(":").at(-1)), ["apply", "compensate", "apply"]);
      }
      assert.deepEqual(after[count], before[count]);
      for (const [index, id] of f.ids.entries()) assert.ok(readFileSync(core.getHistoryPath(f.pmRoot, id), "utf8").startsWith(originalHistory[index]));
      const replay = await apply(f.pmRoot, f.exported.manifest, f.exported.files, { author: "peer-agent" });
      assert.equal(replay.ok, true); assert.equal(replay.changed, 0); assert.equal(replay.applied, 0);
    });
  }
}

test("rollback recovery tolerates repeated interruptions without discarding any native history", async t => {
  const f = await fixture(t, 2);
  for (const point of ["step_compensated", "step_compensating", "compensated"] as const) {
    await interruptSourceRollback(apply, f.pmRoot, f.exported.manifest, f.exported.files, { sdk: core, point });
  }
  const recovered = await apply(f.pmRoot, f.exported.manifest, f.exported.files, { author: "selection-test" });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  for (const id of f.selected) assert.deepEqual((await core.readHistoryEntries(core.getHistoryPath(f.pmRoot, id), id)).slice(1).map(entry => entry.message?.split(":").at(-1)), ["apply", "compensate", "apply", "compensate", "apply", "compensate", "apply"]);
});

for (const selectedIndex of [0, 1]) {
  for (const copiedMarker of [false, true]) {
    test(`rollback recovery refuses a peer revision on row ${selectedIndex}, copied marker ${copiedMarker}`, async t => {
      const f = await fixture(t, 2);
      await interruptSourceRollback(apply, f.pmRoot, f.exported.manifest, f.exported.files, { sdk: core, point: "step_compensated" });
      const history = await core.readHistoryEntries(core.getHistoryPath(f.pmRoot, f.ids[selectedIndex]), f.ids[selectedIndex]);
      await f.client.update(f.ids[selectedIndex], { description: "Peer revision must survive", message: copiedMarker ? history.at(-1)?.message : "Peer edit" });
      const before = await values(f), streams = f.ids.map(id => readFileSync(core.getHistoryPath(f.pmRoot, id), "utf8"));
      const refused = await apply(f.pmRoot, f.exported.manifest, f.exported.files, { author: "selection-test" });
      assert.equal(refused.ok, false); assert.equal(refused.refusals[0].code, "stale_revision"); assert.equal(refused.applied, 0);
      assert.deepEqual(await values(f), before);
      for (const [index, id] of f.ids.entries()) assert.equal(readFileSync(core.getHistoryPath(f.pmRoot, id), "utf8"), streams[index]);
    });
  }
}
