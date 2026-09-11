import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  scaffoldProtocolActionRequestSchema,
  type FactoryActionResult,
  type IdempotencyKey,
  type RepositoryConfiguration,
  type RepositoryKey,
  type RepositoryRegistryEntry,
  type ScaffoldProtocolActionRequest,
} from "../contracts.js";
import type { ScaffoldProtocolActionExecutor } from "../ports.js";
import { ProtocolError, asProtocolError } from "../protocol/errors.js";
import { confinedPath } from "../protocol/files.js";
import { loadProtocolTemplates, type ProtocolTemplate } from "../scaffold/templates.js";
import { readCheckoutBranch } from "../services/live-health.js";
import type { OperationalStateStore, PendingActionIntentRecord } from "../storage/index.js";
import { claimErrorResult, completeIntent, consumedResult, reconcileIntent, recordedIntentResult } from "./intents.js";
import { actionError, actionSuccess, errorMessage } from "./results.js";

type ScaffoldSdk = Pick<BbPluginApi["sdk"], "files" | "terminals">;
type TerminalSession = Awaited<ReturnType<ScaffoldSdk["terminals"]["create"]>>;

export interface ScaffoldProtocolActionExecutorOptions {
  readonly sdk: ScaffoldSdk;
  readonly store: OperationalStateStore;
  readonly repositoryLookup: (repositoryKey: RepositoryKey) => RepositoryRegistryEntry | null;
  readonly now?: () => Date;
}

const COMMIT_MESSAGE = "factory: scaffold protocol";
const COMMIT_POLL_MS = 250;
const COMMIT_TIMEOUT_MS = 60_000;
const HEAD_SHA_RE = /^([0-9a-f]{40})\s*$/mu;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function scaffoldFailure(error: unknown, idempotencyKey: IdempotencyKey): FactoryActionResult {
  const message = errorMessage(error);
  if (error instanceof ProtocolError) {
    const category =
      error.code === "file-not-found" ? "not-found"
      : error.code === "host-unavailable" ? "host-unavailable"
      : error.code === "invalid-configuration" ? "checkout-invalid"
      : "internal";
    return actionError(category, message, idempotencyKey);
  }
  return actionError("internal", message, idempotencyKey);
}

function branchRefusal(configuration: RepositoryConfiguration, branch: string | null, idempotencyKey: IdempotencyKey): FactoryActionResult {
  return actionError(
    "checkout-invalid",
    `Configured checkout '${configuration.checkoutPath}' is on '${branch ?? "no branch"}', expected '${configuration.factoryBranch}'. Switch the checkout to '${configuration.factoryBranch}' or provision a dedicated factory worktree first; this action never creates or switches branches.`,
    idempotencyKey,
  );
}

interface CommitResult {
  readonly ok: boolean;
  readonly sha: string | null;
  readonly output: string;
}

export function createScaffoldProtocolActionExecutor(options: ScaffoldProtocolActionExecutorOptions): ScaffoldProtocolActionExecutor {
  const now = options.now ?? (() => new Date());
  const sdk = options.sdk;

  function decodeOutput(output: { chunks: readonly { dataBase64: string }[] }): string {
    return output.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8")).join("");
  }

  /** Runs the scaffold commit on the connected host and waits for it to exit. */
  async function runCommit(configuration: RepositoryConfiguration): Promise<CommitResult> {
    const command = `cd ${shellQuote(configuration.checkoutPath)} && git add plans && git commit -m "${COMMIT_MESSAGE}" && git rev-parse HEAD`;
    let terminal: TerminalSession;
    try {
      terminal = await sdk.terminals.create({
        cols: 120,
        rows: 30,
        scope: { kind: "host_path", hostId: configuration.connectedHostId, cwd: configuration.checkoutPath },
        start: { mode: "command", command },
        title: "factory scaffold commit",
      });
    } catch (error) {
      // A create failure means the command never started: nothing to reconcile.
      return { ok: false, sha: null, output: `the commit terminal could not be created: ${errorMessage(error)}` };
    }
    try {
      const deadline = now().getTime() + COMMIT_TIMEOUT_MS;
      let session = terminal;
      while ((session.status === "starting" || session.status === "running") && now().getTime() < deadline) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, COMMIT_POLL_MS);
        });
        session = await sdk.terminals.get({ terminalId: terminal.id });
      }
      const output = decodeOutput(await sdk.terminals.output({ terminalId: terminal.id }));
      if (session.status === "disconnected") {
        throw new Error(`the commit terminal disconnected mid-run. Output: ${output || "none"}`);
      }
      if (session.status !== "exited") {
        throw new Error(`the commit did not finish within ${Math.round(COMMIT_TIMEOUT_MS / 1000)}s. Output: ${output || "none"}`);
      }
      return { ok: session.exitCode === 0, sha: HEAD_SHA_RE.exec(output)?.[1] ?? null, output };
    } finally {
      await sdk.terminals.close({ terminalId: terminal.id, mode: "force" }).catch(() => undefined);
    }
  }

  /** True when the target exists inside the checkout; throws on other read failures. */
  async function targetExists(configuration: RepositoryConfiguration, relativePath: string): Promise<boolean> {
    try {
      await sdk.files.read({
        hostId: configuration.connectedHostId,
        path: confinedPath(configuration.checkoutPath, relativePath),
        rootPath: configuration.checkoutPath,
      });
      return true;
    } catch (error) {
      const failure = asProtocolError(error, { path: relativePath, repositoryKey: configuration.repositoryKey });
      if (failure.code === "file-not-found") return false;
      throw failure;
    }
  }

  function scaffoldOutcome(
    status: "accepted" | "already-applied",
    message: string,
    written: readonly string[],
    skipped: readonly string[],
    commitSha: string | null,
  ) {
    return {
      status,
      message,
      revision: null,
      runId: null,
      leaseId: null,
      queueItemId: null,
      action: "scaffold-protocol" as const,
      questionId: null,
      interactionId: null,
      written: [...written],
      skipped: [...skipped],
      commitSha,
    };
  }

  async function execute(request: ScaffoldProtocolActionRequest): Promise<FactoryActionResult> {
    const parsed = scaffoldProtocolActionRequestSchema.safeParse(request);
    if (!parsed.success) {
      return actionError("invalid-input", `Invalid scaffold request: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
    }
    const valid = parsed.data;
    const entry = options.repositoryLookup(valid.repositoryKey);
    if (!entry) {
      return actionError("not-found", `Repository '${valid.repositoryKey}' is not configured.`, valid.idempotencyKey);
    }
    const configuration = entry.configuration;

    // A finished intent replays its recorded result without touching the host.
    const recorded = recordedIntentResult(options.store, valid);
    if (recorded) return recorded;

    // Guard: the commit must land on the factory branch. Provisioning or
    // switching branches is a separate flow; refuse cleanly instead.
    const branch = await readCheckoutBranch(sdk, configuration.connectedHostId, configuration.checkoutPath);
    if (branch !== configuration.factoryBranch) {
      return branchRefusal(configuration, branch, valid.idempotencyKey);
    }

    let templates: readonly ProtocolTemplate[];
    try {
      templates = loadProtocolTemplates();
    } catch (error) {
      return actionError("internal", `The bundled protocol templates could not be loaded: ${errorMessage(error)}`, valid.idempotencyKey);
    }

    // Preflight the write set before claiming; the create-only CAS write below
    // is the real guard, so a file that appears meanwhile lands in `skipped`.
    const missing = new Set<string>();
    const skipped: string[] = [];
    try {
      for (const template of templates) {
        if (await targetExists(configuration, template.target)) {
          skipped.push(template.target);
        } else {
          missing.add(template.target);
        }
      }
    } catch (error) {
      return scaffoldFailure(error, valid.idempotencyKey);
    }

    let record: PendingActionIntentRecord;
    try {
      record = options.store.claimPendingActionIntent({ request: valid, target: { kind: "repository" } }).record;
    } catch (error) {
      return claimErrorResult(error, valid.idempotencyKey);
    }
    if (record.status === "completed" || record.status === "reconciliation-required") {
      return consumedResult(record);
    }

    let consumption;
    try {
      consumption = options.store.consumePendingActionIntent(valid.idempotencyKey);
    } catch (error) {
      return claimErrorResult(error, valid.idempotencyKey);
    }
    if (!consumption.consumed) return consumedResult(consumption.record);
    record = consumption.record;
    const store = options.store;
    const complete = (result: FactoryActionResult, observedStatus?: "written" | "conflict" | "verified") =>
      completeIntent(store, record, result, observedStatus === undefined ? undefined : { observedStatus });
    const reconcile = (message: string, observedStatus?: "written" | "conflict" | "verified") =>
      reconcileIntent(store, record, message, observedStatus === undefined ? undefined : { observedStatus });

    const written: string[] = [];
    for (const template of templates) {
      if (!missing.has(template.target)) continue;
      let outcome;
      try {
        outcome = await sdk.files.write({
          hostId: configuration.connectedHostId,
          path: confinedPath(configuration.checkoutPath, template.target),
          rootPath: configuration.checkoutPath,
          content: template.content,
          createParents: true,
          expectedSha256: null,
        });
      } catch (error) {
        return reconcile(
          `Scaffold write for '${template.target}' failed ambiguously after ${written.length} file(s) were applied: ${errorMessage(error)}`,
          "written",
        );
      }
      if (outcome.outcome === "conflict") {
        // A concurrent creator won the file; never overwrite it.
        skipped.push(template.target);
        continue;
      }
      if (outcome.sha256 !== template.sha256) {
        return reconcile(`Scaffold write for '${template.target}' reported an unexpected resulting digest.`, "written");
      }
      written.push(template.target);
    }

    if (written.length === 0) {
      return complete(
        actionSuccess(scaffoldOutcome("already-applied", "All factory protocol files already exist; nothing was written.", written, skipped, null), null),
        "verified",
      );
    }

    // The branch may have drifted between the preflight read and the writes;
    // never let the commit land on a non-factory branch.
    const branchNow = await readCheckoutBranch(sdk, configuration.connectedHostId, configuration.checkoutPath);
    if (branchNow !== configuration.factoryBranch) {
      return complete(
        actionError(
          "checkout-invalid",
          `Checkout '${configuration.checkoutPath}' drifted to '${branchNow ?? "no branch"}' during scaffolding; ${written.length} file(s) were written and remain uncommitted. Commit them on '${configuration.factoryBranch}' yourself.`,
          valid.idempotencyKey,
        ),
        "written",
      );
    }

    let commit: CommitResult;
    try {
      commit = await runCommit(configuration);
    } catch (error) {
      return reconcile(`The scaffold commit could not be verified and may have landed: ${errorMessage(error)}`, "written");
    }
    if (!commit.ok) {
      return complete(
        actionError(
          "internal",
          `The scaffold commit failed on '${configuration.factoryBranch}' after ${written.length} file(s) were written: ${commit.output || "no terminal output"}`,
          valid.idempotencyKey,
        ),
        "written",
      );
    }

    const message = commit.sha === null
      ? `Wrote ${written.length} factory protocol file(s) and committed them on '${configuration.factoryBranch}' (the commit sha could not be read from terminal output).`
      : `Wrote ${written.length} factory protocol file(s) and committed them on '${configuration.factoryBranch}' (${commit.sha}).`;
    return complete(actionSuccess(scaffoldOutcome("accepted", message, written, skipped, commit.sha), null), "verified");
  }

  return { execute };
}
