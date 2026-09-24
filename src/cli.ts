import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";

import { normalizeAbsolutePath, readTextFile, type ProtocolFileReadResult, type ProtocolFiles } from "./protocol/files.js";
import { ProtocolError } from "./protocol/errors.js";
import { PROTOCOL_PATHS } from "./protocol/paths.js";
import {
  formatProtocolDiagnostic,
  validateProtocolFiles,
  type ProtocolDiagnostic,
} from "./protocol/validation.js";

type FactorySdk = Pick<BbPluginApi["sdk"], "threads" | "environments" | "files">;

interface ValidateOptions {
  readonly path?: string;
  readonly host?: string;
  readonly json: boolean;
}

interface ValidateTarget {
  readonly hostId: string;
  readonly rootPath: string;
}

function cliError(message: string, code: string, hint: string): PluginCliError {
  return new PluginCliError(message, { code, hint });
}

async function resolveTarget(
  sdk: FactorySdk,
  ctx: PluginCliContext,
  options: Pick<ValidateOptions, "path" | "host">,
): Promise<ValidateTarget> {
  if (ctx.threadId) {
    const thread = await sdk.threads.get({ threadId: ctx.threadId, signal: ctx.signal });
    const environmentId = thread.environmentId;
    if (!environmentId) {
      if (options.path && options.host) return normalizedTarget(options.host, options.path);
      throw cliError(
        "The invoking thread has no environment",
        "thread_environment_missing",
        "Pass both --path <checkout> and --host <id> to validate an explicit checkout.",
      );
    }
    const environment = await sdk.environments.get({ environmentId, signal: ctx.signal });
    const hostId = options.host ?? environment.hostId;
    const rootPath = options.path ?? environment.path ?? ctx.cwd;
    if (hostId && rootPath) return normalizedTarget(hostId, rootPath);
  } else if (options.path && options.host) {
    return normalizedTarget(options.host, options.path);
  }

  throw cliError(
    "A checkout could not be resolved for protocol validation",
    "validation_target_missing",
    "Run from a BB thread with an environment, or pass both --path <checkout> and --host <id>.",
  );
}

function normalizedTarget(hostId: string, rootPath: string): ValidateTarget {
  if (!hostId.trim()) {
    throw cliError("The host id is empty", "host_missing", "Pass a connected host id with --host <id>.");
  }
  try {
    return { hostId, rootPath: normalizeAbsolutePath(rootPath, "checkout") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw cliError(message, "invalid_checkout", "Pass an absolute checkout path with --path <checkout>.");
  }
}

function protocolFiles(sdk: FactorySdk): ProtocolFiles {
  return {
    read: async (args): Promise<ProtocolFileReadResult> => sdk.files.read(args) as Promise<ProtocolFileReadResult>,
    listPaths: async () => ({ paths: [], truncated: false }),
  };
}

async function readContents(
  sdk: FactorySdk,
  target: ValidateTarget,
  signal?: AbortSignal,
): Promise<{
  readonly repo: string;
  readonly queue: string;
  readonly done?: string;
  readonly questions: string;
  readonly current: string;
  readonly dashboard: string;
}> {
  const files = protocolFiles(sdk);
  const read = (relativePath: string) => readTextFile(files, {
    hostId: target.hostId,
    rootPath: target.rootPath,
    relativePath,
    signal,
  });
  const [, repo, queue, questions, current, dashboard] = await Promise.all([
    read(PROTOCOL_PATHS.foreman),
    read(PROTOCOL_PATHS.repo),
    read(PROTOCOL_PATHS.queue),
    read(PROTOCOL_PATHS.questions),
    read(PROTOCOL_PATHS.current),
    read(PROTOCOL_PATHS.dashboard),
  ]);
  let done: string | undefined;
  try {
    done = (await read(PROTOCOL_PATHS.done)).content;
  } catch (error) {
    if (!(error instanceof ProtocolError) || error.code !== "file-not-found") throw error;
  }
  return {
    repo: repo.content,
    queue: queue.content,
    ...(done === undefined ? {} : { done }),
    questions: questions.content,
    current: current.content,
    dashboard: dashboard.content,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}

function boundedOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= PLUGIN_CLI_OUTPUT_MAX_BYTES) return value;
  const suffix = "\nvalidation output exceeded the BB CLI limit\n";
  const maxBodyBytes = Math.max(0, PLUGIN_CLI_OUTPUT_MAX_BYTES - Buffer.byteLength(suffix, "utf8"));
  return `${truncateUtf8(value, maxBodyBytes)}${suffix}`;
}

function jsonResult(
  ok: boolean,
  diagnostics: readonly ProtocolDiagnostic[],
  truncatedCount = 0,
): string {
  return JSON.stringify({
    ok,
    diagnostics,
    ...(truncatedCount > 0 ? { truncatedCount } : {}),
  });
}

function boundedJsonResult(ok: boolean, diagnostics: readonly ProtocolDiagnostic[]): string {
  const complete = jsonResult(ok, diagnostics);
  if (Buffer.byteLength(complete, "utf8") <= PLUGIN_CLI_OUTPUT_MAX_BYTES) return complete;

  const prefix = `{"ok":${ok},"diagnostics":[`;
  let body = prefix;
  for (let index = 0; index < diagnostics.length; index += 1) {
    const serialized = JSON.stringify(diagnostics[index]);
    const candidateBody = `${body}${index === 0 ? "" : ","}${serialized}`;
    const omitted = diagnostics.length - index - 1;
    const suffix = omitted > 0 ? `],"truncatedCount":${omitted}}` : "]}";
    if (Buffer.byteLength(`${candidateBody}${suffix}`, "utf8") > PLUGIN_CLI_OUTPUT_MAX_BYTES) {
      const truncated = jsonResult(ok, diagnostics.slice(0, index), diagnostics.length - index);
      return Buffer.byteLength(truncated, "utf8") <= PLUGIN_CLI_OUTPUT_MAX_BYTES
        ? truncated
        : jsonResult(ok, [], diagnostics.length);
    }
    body = candidateBody;
  }
  return `${body}]}`;
}

export async function runFactoryValidate(
  sdk: FactorySdk,
  options: ValidateOptions,
  ctx: PluginCliContext = {},
): Promise<PluginCliResult> {
  const target = await resolveTarget(sdk, ctx, options);
  let contents;
  try {
    contents = await readContents(sdk, target, ctx.signal);
  } catch (error) {
    const message = error instanceof ProtocolError ? error.message : error instanceof Error ? error.message : String(error);
    throw cliError(message, "protocol_read_failed", "Check the checkout path, host, and protocol file permissions.");
  }
  const diagnostics = validateProtocolFiles(contents);
  if (diagnostics.length === 0) {
    return {
      exitCode: 0,
      stdout: options.json ? boundedJsonResult(true, []) : "protocol ok\n",
    };
  }
  const output = options.json
    ? boundedJsonResult(false, diagnostics)
    : diagnostics.map(formatProtocolDiagnostic).join("\n") + "\n";
  return { exitCode: 1, stdout: boundedOutput(output) };
}

export function registerFactoryCli(bb: Pick<BbPluginApi, "cli" | "sdk">): void {
  bb.cli.register(defineCli({
    name: "factory",
    summary: "Inspect and validate factory protocol files.",
    description: "Validate a remote checkout through the BB server and report every protocol problem.",
    commands: {
      validate: cliCommand({
        summary: "Validate factory protocol files.",
        description: "Reads foreman.md, repo.md, queue.md, done.md when present, questions.md, current.md, and plans/README.md.",
        options: {
          path: {
            type: "string",
            placeholder: "checkout",
            description: "Absolute checkout path on the resolved host.",
          },
          host: {
            type: "string",
            placeholder: "id",
            description: "Connected host id to use when no thread resolves one.",
          },
          json: { type: "boolean", description: "Emit structured JSON diagnostics." },
        },
        async run(input, ctx) {
          return runFactoryValidate(bb.sdk, {
            path: input.options.path,
            host: input.options.host,
            json: input.options.json,
          }, ctx);
        },
      }),
    },
  }));
}
