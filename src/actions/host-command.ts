import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { errorMessage } from "../errors.js";

export type HostTerminals = BbPluginApi["sdk"]["terminals"];
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

function decodeOutput(output: { chunks: readonly { dataBase64: string }[] }): string {
  return output.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8")).join("");
}

/**
 * Runs one command-mode terminal on a connected host and waits for it to
 * exit. A create failure throws HostCommandStartError (nothing ran); a
 * disconnect or timeout throws HostCommandLostError (the result is
 * ambiguous); a non-zero exit is a normal result the caller interprets. The
 * terminal is always force-closed.
 */
export async function runHostCommand(
  terminals: HostTerminals,
  options: HostCommandOptions,
  now: () => Date = () => new Date(),
): Promise<HostCommandResult> {
  let terminal: TerminalSession;
  try {
    terminal = await terminals.create({
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      scope: { kind: "host_path", hostId: options.hostId, cwd: options.cwd },
      start: { mode: "command", command: options.command },
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
      session = await terminals.get({ terminalId: terminal.id });
    }
    const output = decodeOutput(await terminals.output({ terminalId: terminal.id }));
    if (session.status === "disconnected") {
      throw new HostCommandLostError(`the host command terminal disconnected mid-run. Output: ${output || "none"}`);
    }
    if (session.status !== "exited") {
      throw new HostCommandLostError(`the host command did not finish within ${Math.round(timeoutMs / 1000)}s. Output: ${output || "none"}`);
    }
    return { exitCode: session.exitCode, output };
  } finally {
    await terminals.close({ terminalId: terminal.id, mode: "force" }).catch(() => undefined);
  }
}
