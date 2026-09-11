import { describe, expect, it, vi } from "vitest";
import { repositoryActionRequestSchema, type FactoryActionResult } from "../src/contracts.js";
import { createFactoryRpcHandlers } from "../src/rpc/action-router.js";
import type { FactoryComposition } from "../src/services/action-composition.js";
import { makeRegistryEntry } from "./fakes.js";

const revision = { gitCommit: "abc1234", protocolDigest: "a".repeat(64), fileDigests: {} };

const accepted = (action: string): FactoryActionResult => ({
  ok: true,
  revision,
  result: {
    status: "accepted",
    message: `${action} applied.`,
    revision,
    runId: null,
    leaseId: null,
    queueItemId: null,
    action: action as never,
    ...(action === "answer-question" ? { source: "repository-question" } : {}),
    questionId: action === "answer-question" ? "Q1" : null,
    interactionId: null,
  },
} as FactoryActionResult);

function makeComposition(overrides: Partial<FactoryComposition> = {}) {
  const entry = makeRegistryEntry();
  const composition = {
    settings: {},
    resolution: { status: "configured", source: "registry", repositories: [entry], selectedRepositoryKey: "monorepo" },
    operationalState: {},
    protocolReader: {},
    healthReader: {},
    interactionReader: {},
    listRepositories: vi.fn(),
    getRepositoryEntry: (key: string) => (key === "monorepo" ? entry : null),
    getSettingsProjection: vi.fn(),
    readOnlyActionExecutor: { execute: vi.fn(async () => accepted("preview")) },
    repositoryActionExecutor: { execute: vi.fn(async () => accepted("answer-question")) },
    bbInteractionActionExecutor: { execute: vi.fn(async () => accepted("run-now")) },
    scaffoldProtocolActionExecutor: {
      execute: vi.fn(async (): Promise<FactoryActionResult> => ({
        ok: true,
        revision: null,
        result: {
          status: "accepted",
          message: "scaffolded",
          revision: null,
          runId: null,
          leaseId: null,
          queueItemId: null,
          action: "scaffold-protocol",
          questionId: null,
          interactionId: null,
          written: ["plans/factory/foreman.md"],
          skipped: [],
          commitSha: "abc1234",
        },
      })),
    },
    provisionCheckoutActionExecutor: {
      execute: vi.fn(async (): Promise<FactoryActionResult> => ({
        ok: true,
        revision: null,
        result: {
          status: "preview",
          message: "verified",
          revision: null,
          runId: null,
          leaseId: null,
          queueItemId: null,
          action: "provision-checkout",
          questionId: null,
          interactionId: null,
          mode: "direct",
          outcome: "verified",
          checkoutPath: "/repo",
          branch: "factory",
          blockingWorktreePath: null,
          branchCreated: null,
          branchExisted: null,
          baseRef: null,
        },
      })),
    },
    dispatchEngine: {},
    dispatchContext: {},
    scheduler: { tick: vi.fn() },
    ...overrides,
  } as unknown as FactoryComposition;
  const publish = vi.fn();
  const handlers = createFactoryRpcHandlers(() => composition, publish);
  return { composition, publish, handlers };
}

const answerQuestion = repositoryActionRequestSchema.parse({
  repositoryKey: "monorepo",
  action: { kind: "answer-question", source: "repository-question", questionId: "Q1", answer: "Use codex." },
  idempotencyKey: "bbf:v1:monorepo:answer-question:423e4567-e89b-12d3-a456-426614174000",
  expectedRevision: revision,
});

describe("factory action RPC router", () => {
  it("rejects malformed requests with invalid-input instead of throwing", async () => {
    const { handlers } = makeComposition();
    const result = await handlers.factory_action({ repositoryKey: "monorepo" } as never);
    expect(result).toMatchObject({ ok: false, error: { category: "invalid-input" } });
  });

  it("rejects actions for unconfigured repositories", async () => {
    const { handlers, composition } = makeComposition();
    const result = await handlers.factory_action({
      ...answerQuestion,
      repositoryKey: "unknown",
      idempotencyKey: "bbf:v1:unknown:answer-question:423e4567-e89b-12d3-a456-426614174000",
    });
    expect(result).toMatchObject({ ok: false, error: { category: "not-found" } });
    expect(composition.repositoryActionExecutor.execute).not.toHaveBeenCalled();
  });

  it("routes repository actions to the repository executor and publishes on success", async () => {
    const { handlers, composition, publish } = makeComposition();
    const result = await handlers.factory_action(answerQuestion);
    expect(result.ok).toBe(true);
    expect(composition.repositoryActionExecutor.execute).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: answerQuestion.idempotencyKey,
    }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      channel: "factory",
      kind: "repository.changed",
      repositoryKey: "monorepo",
    }));
  });

  it("routes BB interaction and run controls to the interaction executor", async () => {
    const { handlers, composition } = makeComposition();
    const result = await handlers.factory_action({
      repositoryKey: "monorepo",
      action: { kind: "run-now" },
      idempotencyKey: "bbf:v1:monorepo:run-now:523e4567-e89b-12d3-a456-426614174000",
      expectedRevision: revision,
    });
    expect(result.ok).toBe(true);
    expect(composition.bbInteractionActionExecutor.execute).toHaveBeenCalled();
  });

  it("routes scaffold-protocol actions to the scaffold executor", async () => {
    const { handlers, composition, publish } = makeComposition();
    const result = await handlers.factory_action({
      repositoryKey: "monorepo",
      action: { kind: "scaffold-protocol" },
      idempotencyKey: "bbf:v1:monorepo:scaffold-protocol:823e4567-e89b-12d3-a456-426614174000",
      expectedRevision: revision,
    });
    expect(result.ok).toBe(true);
    expect(composition.scaffoldProtocolActionExecutor.execute).toHaveBeenCalledWith(expect.objectContaining({
      action: { kind: "scaffold-protocol" },
    }));
    expect(composition.repositoryActionExecutor.execute).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ kind: "repository.changed" }));
  });

  it("routes provision-checkout actions to the provision executor", async () => {
    const { handlers, composition } = makeComposition();
    const result = await handlers.factory_action({
      repositoryKey: "monorepo",
      action: { kind: "provision-checkout", mode: "worktree" },
      idempotencyKey: "bbf:v1:monorepo:provision-checkout:923e4567-e89b-42d3-8456-426614174000",
      expectedRevision: revision,
    });
    expect(result.ok).toBe(true);
    expect(composition.provisionCheckoutActionExecutor.execute).toHaveBeenCalledWith(expect.objectContaining({
      action: { kind: "provision-checkout", mode: "worktree" },
    }));
    expect(composition.repositoryActionExecutor.execute).not.toHaveBeenCalled();
  });

  it("routes provision-checkout with an explicit target for an unconfigured repository", async () => {
    const { handlers, composition } = makeComposition();
    const result = await handlers.factory_action({
      repositoryKey: "newrepo",
      action: { kind: "provision-checkout", mode: "direct", hostId: "host-1", repositoryRoot: "/repo" },
      idempotencyKey: "bbf:v1:newrepo:provision-checkout:923e4567-e89b-42d3-8456-426614174000",
      expectedRevision: revision,
    });
    expect(result.ok).toBe(true);
    expect(composition.provisionCheckoutActionExecutor.execute).toHaveBeenCalled();
  });

  it("rejects provision-checkout without an explicit target for an unconfigured repository", async () => {
    const { handlers, composition } = makeComposition();
    const result = await handlers.factory_action({
      repositoryKey: "newrepo",
      action: { kind: "provision-checkout", mode: "direct" },
      idempotencyKey: "bbf:v1:newrepo:provision-checkout:923e4567-e89b-42d3-8456-426614174000",
      expectedRevision: revision,
    });
    expect(result).toMatchObject({ ok: false, error: { category: "not-found" } });
    expect(composition.provisionCheckoutActionExecutor.execute).not.toHaveBeenCalled();
  });

  it("routes revision-free actions to the read-only executor without a revision", async () => {
    const { handlers, composition } = makeComposition();
    const result = await handlers.factory_action({
      repositoryKey: "monorepo",
      action: { kind: "preview" },
      idempotencyKey: "bbf:v1:monorepo:preview:623e4567-e89b-12d3-a456-426614174000",
    });
    expect(result.ok).toBe(true);
    expect(composition.readOnlyActionExecutor.execute).toHaveBeenCalled();
    expect(composition.repositoryActionExecutor.execute).not.toHaveBeenCalled();
  });

  it("converts executor throws into structured internal errors", async () => {
    const composition = makeComposition();
    (composition.composition.repositoryActionExecutor.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk full"));
    const result = await composition.handlers.factory_action(answerQuestion);
    expect(result).toMatchObject({ ok: false, error: { category: "internal" } });
    expect(composition.publish).not.toHaveBeenCalled();
  });

  it("converts malformed executor results into internal errors", async () => {
    const composition = makeComposition();
    (composition.composition.repositoryActionExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: "yes" });
    const result = await composition.handlers.factory_action(answerQuestion);
    expect(result).toMatchObject({ ok: false, error: { category: "internal" } });
  });

  it("does not publish invalidation for failed actions", async () => {
    const composition = makeComposition({
      repositoryActionExecutor: { execute: vi.fn(async () => ({ ok: false, error: { category: "paused", message: "paused" } })) } as never,
    });
    const result = await composition.handlers.factory_action(answerQuestion);
    expect(result.ok).toBe(false);
    expect(composition.publish).not.toHaveBeenCalled();
  });
});

describe("factory_resolve_project", () => {
  it("creates the project through the composition sdk", async () => {
    const create = vi.fn(async (args: { name: string }) => ({ id: "proj-new", name: args.name }));
    const sdk = {
      projects: {
        list: vi.fn(async () => []),
        create,
      },
    };
    const { handlers } = makeComposition({ sdk } as never);
    const result = await handlers.factory_resolve_project({
      hostId: "host-1",
      path: "/work/repo",
      name: "repo",
    });
    expect(create).toHaveBeenCalledWith({
      name: "repo",
      source: { type: "local_path", hostId: "host-1", path: "/work/repo" },
    });
    expect(result).toEqual({ projectId: "proj-new", label: "repo", created: true });
  });

  it("returns an existing matching project without creating one", async () => {
    const create = vi.fn();
    const sdk = {
      projects: {
        list: vi.fn(async () => [
          { id: "proj-7", name: "Core", sources: [{ type: "local_path", hostId: "host-1", path: "/work/repo" }] },
        ]),
        create,
      },
    };
    const { handlers } = makeComposition({ sdk } as never);
    const result = await handlers.factory_resolve_project({
      hostId: "host-1",
      path: "/work/repo",
      name: "repo",
    });
    expect(result).toEqual({ projectId: "proj-7", label: "Core", created: false });
    expect(create).not.toHaveBeenCalled();
  });
});
