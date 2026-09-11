import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { errorMessage } from "../errors.js";

export type HostCommandSdk = Pick<BbPluginApi["sdk"], "files" | "terminals">;
export type HostTerminals = HostCommandSdk["terminals"];
type TerminalSession = Awaited<ReturnType<HostTerminals["create"]>>;

const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 30;
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_MS = 250;

/** The terminal never started: the command definitively did not run. */
export class HostCommandStartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HostCommandStartError";
  }
}

/**
 * The command's outcome could not be observed (the terminal disconnected or
 * the wait timed out). For a mutating command the change may have landed.
 */
export class HostCommandLostError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HostCommandLostError";
  }
}

export interface HostCommandResult {
  readonly exitCode: number | null;
  readonly output: string;
}

export interface HostCommandOptions {
  readonly hostId: string;
  readonly cwd: string;
  readonly command: string;
  readonly title: string;
  readonly timeoutMs?: number;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Runs one command-mode terminal on a connected host and waits for it to
 * exit. `terminals.output` is a stream-only buffer: the server answers 409
 * `terminal_output_unavailable` for any session not currently running, so a
 * command that exits before the first read destroys its output. The command
 * is therefore wrapped in a redirect to a per-run temp file, which is read
 * back through `files` (durable at any session state) and then removed.
 * A create failure throws HostCommandStartError (nothing ran); a
 * disconnect, timeout, or unreadable output file throws
 * HostCommandLostError (the result is ambiguous); a non-zero exit is a
 * normal result the caller interprets. The terminal is always force-closed.
 */
export async function runHostCommand(
  sdk: HostCommandSdk,
  options: HostCommandOptions,
  now: () => Date = () => new Date(),
): Promise<HostCommandResult> {
  const outPath = `/tmp/bb-factory-cmd-${randomUUID()}.out`;
  let terminal: TerminalSession;
  try {
    terminal = await sdk.terminals.create({
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      scope: { kind: "host_path", hostId: options.hostId, cwd: options.cwd },
      start: { mode: "command", command: `{ ${options.command} ; } > ${shellQuote(outPath)} 2>&1` },
      title: options.title,
    });
  } catch (error) {
    throw new HostCommandStartError(errorMessage(error), { cause: error });
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const deadline = now().getTime() + timeoutMs;
    let session = terminal;
    while ((session.status === "starting" || session.status === "running") && now().getTime() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, POLL_MS);
      });
      session = await sdk.terminals.get({ terminalId: terminal.id });
    }
    let output = "";
    let outputError: unknown;
    try {
      const read = await sdk.files.read({ hostId: options.hostId, path: outPath });
      output = read.contentEncoding === "base64" ? Buffer.from(read.content, "base64").toString("utf8") : read.content;
    } catch (error) {
      outputError = error;
    }
    await sdk.files.remove({ hostId: options.hostId, path: outPath }).catch(() => undefined);
    if (session.status === "disconnected") {
      throw new HostCommandLostError(`the host command terminal disconnected mid-run. Output: ${output || "none"}`);
    }
    if (session.status !== "exited") {
      throw new HostCommandLostError(`the host command did not finish within ${Math.round(timeoutMs / 1000)}s. Output: ${output || "none"}`);
    }
    if (outputError !== undefined) {
      throw new HostCommandLostError(`the host command exited but its output could not be read: ${errorMessage(outputError)}`);
    }
    return { exitCode: session.exitCode, output };
  } finally {
    await sdk.terminals.close({ terminalId: terminal.id, mode: "force" }).catch(() => undefined);
  }
}
