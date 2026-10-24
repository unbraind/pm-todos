/** Early timer wakes exercise the real command, filesystem and SDK tracker outside git. */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, init } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { exportTodoEditingSession, type TodoChangeProposal, type TodoWatcherReceipt } from "../index.ts";
import { runTodoWatchCommand, type TodoWatcherClock } from "../watcher.ts";

/** Isolate source, queue and a real non-git tracker; preserve source and history bytes. */
async function withSource(run: (ctx: CommandHandlerContext, edited: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "todos-watch-timing-"));
  const ceiling = process.env.GIT_CEILING_DIRECTORIES, path = process.env.PATH;
  const exit = process.exitCode;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  try {
    const pmRoot = join(root, "tracker");
    await init(undefined, {}, { pmRoot, cwd: root, noExtensions: true });
    const created = await create({ title: "Original task", type: "Task", author: "test-agent" }, { pmRoot });
    const baseline = await exportTodoEditingSession(pmRoot);
    const history = join(pmRoot, "history", `${created.item.id}.jsonl`);
    const before = readFileSync(history, "utf8");
    const file = join(root, "todo.txt"), session = join(root, "session.json");
    const edited = baseline.text.replace("Original task", "Edited task");
    writeFileSync(file, edited);
    writeFileSync(session, JSON.stringify(baseline.session));
    process.env.PATH = root; // No git executable, including during complete tracker reads.
    await run({ command: "todos watch", args: [], global: {}, pm_root: pmRoot, options: { file, session, spool: join(root, "queue"), "stable-ms": 1 } }, edited);
    assert.equal(readFileSync(history, "utf8"), before);
    assert.equal(readFileSync(session, "utf8"), JSON.stringify(baseline.session));
    assert.equal(existsSync(join(root, ".git")), false);
  } finally {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    process.exitCode = exit;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Inspect persisted evidence rather than trusting a successful receipt alone. */
function proposals(ctx: CommandHandlerContext): TodoChangeProposal[] {
  return (JSON.parse(readFileSync(join(String(ctx.options.spool), "proposals.json"), "utf8")) as { proposals: TodoChangeProposal[] }).proposals;
}

test("one-shot command rechecks the monotonic clock after early timer wakes", async () => {
  await withSource(async (ctx, edited) => {
    let now = 0, sleeps = 0;
    const clock: TodoWatcherClock = {
      now: () => now,
      sleep: async ms => { assert.equal(ms, 1); now += ++sleeps === 1 ? 0.75 : 0.25; },
    };
    const result = await runTodoWatchCommand(ctx, clock) as TodoWatcherReceipt;
    assert.equal(result.state, "queued");
    assert.equal(result.ok, true);
    assert.equal(sleeps, 2);
    assert.equal(proposals(ctx).length, 1);
    assert.equal(proposals(ctx)[0].text, edited);
    assert.equal(proposals(ctx)[0].patches[0].values.title, "Edited task");
    assert.equal(readFileSync(String(ctx.options.file), "utf8"), edited);
    const duplicate = await runTodoWatchCommand(ctx, clock) as TodoWatcherReceipt;
    assert.equal(duplicate.state, "duplicate");
    assert.equal(duplicate.proposalId, result.proposalId);
    assert.equal(proposals(ctx).length, 1);
  });
});

test("one-shot command refuses still_waiting nonzero when changing sources exhaust either budget", async () => {
  await withSource(async (ctx, edited) => {
    for (const stableMs of [1, 60_000]) {
      let now = 0, sleeps = 0;
      ctx.options["stable-ms"] = stableMs;
      ctx.options["poll-ms"] = 60_000;
      const budget = Math.max(1000, 3 * stableMs);
      const clock: TodoWatcherClock = {
        now: () => now,
        sleep: async ms => {
          assert.ok(ms > 0 && ms <= stableMs);
          now += budget / 2;
          writeFileSync(String(ctx.options.file), edited.replace("Edited task", `Changing task ${++sleeps}`));
        },
      };
      const result = await runTodoWatchCommand(ctx, clock) as TodoWatcherReceipt;
      assert.equal(result.ok, false);
      assert.equal(result.state, "refused");
      assert.equal(result.refusal?.code, "still_waiting");
      assert.match(result.refusal.remedy, /stop the source writer.*--follow/);
      assert.equal(process.exitCode, 1);
      assert.equal(now, budget);
      assert.equal(sleeps, 2);
      assert.equal(existsSync(join(String(ctx.options.spool), "proposals.json")), false);
    }
  });
});

test("one-shot command refuses an overslept deadline before another sample", async () => {
  await withSource(async ctx => {
    let now = 0;
    const clock: TodoWatcherClock = { now: () => now, sleep: async () => { now = 1001; } };
    const result = await runTodoWatchCommand(ctx, clock) as TodoWatcherReceipt;
    assert.equal(result.refusal?.code, "still_waiting");
    assert.equal(process.exitCode, 1);
    assert.equal(existsSync(join(String(ctx.options.spool), "proposals.json")), false);
  });
});

test("one-shot command persists explicit zero-change evidence", async () => {
  await withSource(async ctx => {
    const baseline = await exportTodoEditingSession(ctx.pm_root);
    writeFileSync(String(ctx.options.file), baseline.text);
    const result = await runTodoWatchCommand(ctx) as TodoWatcherReceipt;
    assert.equal(result.state, "queued");
    assert.equal(result.changed, 0);
    assert.deepEqual(proposals(ctx)[0].patches, []);
  });
});

test("one-shot real-timer command queues durable proposals in 200 serial cycles without git", async () => {
  await withSource(async (ctx, edited) => {
    const spool = String(ctx.options.spool);
    for (let iteration = 0; iteration < 200; iteration++) {
      ctx.options.spool = `${spool}-${iteration}`;
      const result = await runTodoWatchCommand(ctx) as TodoWatcherReceipt;
      assert.equal(result.state, "queued", `cycle ${iteration + 1}`);
      assert.equal(proposals(ctx).length, 1);
      assert.equal(proposals(ctx)[0].text, edited);
    }
  });
});
