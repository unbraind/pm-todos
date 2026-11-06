import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/** Diagnostic state owned by the packed-consumer matrix, never child output. */
export interface PackedAcceptanceState {
  scenario: string;
  phase: string;
  host_version?: string;
  selected_scenarios: readonly string[];
  runtimes: { node: string; npm?: string; bun?: string };
  receipts: { readonly scenario: string }[];
}

/** Retain only known progress grammar; arbitrary fixture and credential text is private. */
export function summarizePackedOutput(output: string | null) {
  const text = output ?? "";
  const sample = text.length > 16384 ? text.slice(0, 8192) + "\n" + text.slice(-8192) : text;
  const progress = sample.split(/\r?\n/u).map(line => line.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, "").trim()).filter(line =>
    /^(?:Resolving dependencies|Installing dependencies|Saved lockfile|Resolved, downloaded and extracted \[\d{1,8}\]|bun (?:init|install|add) v\d{1,4}\.\d{1,4}\.\d{1,4}(?: \([a-f0-9]{1,40}\))?)$/u.test(line),
  ).slice(0, 16);
  return { bytes: Buffer.byteLength(text), progress, other_output: text.trim().length > 0, truncated: text.length > 16384 };
}

/** Only the exact selected matrix may emit a complete receipt. */
export function packedMatrixReport(state: PackedAcceptanceState, complete: boolean) {
  if (complete && (!state.selected_scenarios.length || state.receipts.length !== state.selected_scenarios.length ||
    state.receipts.some((receipt, index) => receipt.scenario !== state.selected_scenarios[index]))) {
    throw new PackedValidationError("matrix_receipts_incomplete_or_misordered");
  }
  return { ok: complete, matrix_complete: complete, scenario: state.scenario, phase: state.phase, host_version: state.host_version,
    selected_scenarios: [...state.selected_scenarios], runtimes: { ...state.runtimes }, receipts: [...state.receipts] };
}

/** A trusted assertion identifier, kept separate from arbitrary exception messages. */
export class PackedValidationError extends Error {
  readonly validation: string;

  /** Store an identifier supplied by the acceptance script's own assertions. */
  constructor(validation: string) {
    super(validation);
    this.validation = validation;
  }
}

/** Structured failures avoid printing command arguments or raw subprocess output. */
export class PackedCommandError extends Error {
  readonly report: ReturnType<typeof packedMatrixReport> & {
    reason: string; timeout_ms: number; status: number | null; signal: string | null;
    stdout: ReturnType<typeof summarizePackedOutput>; stderr: ReturnType<typeof summarizePackedOutput>;
  };

  /** Snapshot completed receipts and bounded stream context before cleanup. */
  constructor(state: PackedAcceptanceState, result: SpawnSyncReturns<string>, timeoutMs: number) {
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const reason = code === "ETIMEDOUT" || code === "ENOBUFS" || code === "ENOENT" || code === "EACCES" ? code : "subprocess_failed";
    const report = { ...packedMatrixReport(state, false), reason, timeout_ms: timeoutMs, status: result.status,
      signal: result.signal, stdout: summarizePackedOutput(result.stdout), stderr: summarizePackedOutput(result.stderr) };
    super(JSON.stringify(report));
    this.report = report;
  }
}

/** Preserve trusted validation reasons while hiding parser, filesystem and fixture text. */
export function packedFailureReport(state: PackedAcceptanceState, error: unknown) {
  if (error instanceof PackedCommandError) return error.report;
  return { ...packedMatrixReport(state, false), reason: "acceptance_validation_failed",
    validation: error instanceof PackedValidationError ? error.validation : error instanceof SyntaxError ? "invalid_json" : "unexpected_error" };
}

/** Run one shell-free command with the unchanged five-minute production bound. */
export function runPackedCommand(state: PackedAcceptanceState, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, expectedStatus = 0, timeoutMs = 300000): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" });
  if (result.error || result.status !== expectedStatus) throw new PackedCommandError(state, result, timeoutMs);
  return result;
}
