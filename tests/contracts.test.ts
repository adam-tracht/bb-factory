import { describe, expect, it } from "vitest";
import {
  bbInteractionActionRequestSchema,
  factoryActionRequestSchema,
  factoryActionResultSchema,
  factoryErrorSchema,
  factorySettingsSchema,
  healthProjectionSchema,
  invalidationEventSchema,
  idempotencyKeySchema,
  operationalRunDetailInputSchema,
  operationalRunDetailProjectionSchema,
  operationalRunListInputSchema,
  operationalRunListProjectionSchema,
  pendingInteractionsProjectionSchema,
  questionSchema,
  queueStatusSchema,
  repositorySelectionInputSchema,
  repositorySelectionProjectionSchema,
  repositoryActionRequestSchema,
  scheduleSettingsSchema,
  settingsProjectionSchema,
  staleRevisionErrorVariantSchema,
} from "../src/contracts.js";
import { factorySettingDescriptors } from "../src/settings.js";

const repositoryRevision = {
  gitCommit: "72eaaf7",
  protocolDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  fileDigests: {
    "plans/factory/queue.md": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  },
};

describe("Phase 0 wire contracts", () => {
  it("accepts only the versioned idempotency-key shape", () => {
    const valid = "bbf:v1:monorepo:run-now:123e4567-e89b-12d3-a456-426614174000";
    expect(idempotencyKeySchema.parse(valid)).toBe(valid);
    expect(() => idempotencyKeySchema.parse("run-now-monorepo")).toThrow();
  });

  it("preserves live queue status detail and omitted question recommendations", () => {
    expect(queueStatusSchema.parse({ kind: "done" })).toEqual({ kind: "done" });
    expect(
      queueStatusSchema.parse({ kind: "blocked-by", questionId: "Q6", detail: "Q6 (detail)" }),
    ).toEqual({ kind: "blocked-by", questionId: "Q6", detail: "Q6 (detail)" });

    const question = {
      id: "Q6",
      date: "2026-09-10",
      classification: "blocking",
      dashboardId: "Q6",
      question: "Which provider should run?",
      context: "The provider pin is not yet migrated.",
      assumed: null,
      answer: null,
    };
    expect(questionSchema.parse(question)).toEqual(question);
  });

  it("enforces the rolling-hour minimum start gap", () => {
    expect(() => scheduleSettingsSchema.parse({ cron: "0 * * * *", minimumStartGapSeconds: 3599 })).toThrow();
    expect(scheduleSettingsSchema.parse({ cron: "0 * * * *", minimumStartGapSeconds: 3600 }).minimumStartGapSeconds).toBe(3600);
    expect(() => factorySettingsSchema.parse({ minimumStartGapSeconds: 3599 })).toThrow();
    expect(factorySettingsSchema.parse({ minimumStartGapSeconds: 3600 }).minimumStartGapSeconds).toBe(3600);
    expect(() => factorySettingDescriptors.minimumStartGapSeconds.experimental_schema.parse(3599)).toThrow();
    expect(factorySettingDescriptors.minimumStartGapSeconds.experimental_schema.parse(3600)).toBe(3600);
  });

  it("requires revisions for guarded actions and scopes revision-free actions", () => {
    const request = {
      repositoryKey: "monorepo",
      action: { kind: "run-now" },
      idempotencyKey: "bbf:v1:monorepo:run-now:123e4567-e89b-12d3-a456-426614174000",
      expectedRevision: repositoryRevision,
    };

    expect(factoryActionRequestSchema.parse(request)).toEqual(request);
    expect(() => factoryActionRequestSchema.parse({ ...request, expectedRevision: undefined })).toThrow();
    expect(() => factoryActionRequestSchema.parse({ ...request, expectedRevision: null })).toThrow();

    const preview = {
      repositoryKey: "monorepo",
      action: { kind: "preview" },
      idempotencyKey: "bbf:v1:monorepo:preview:123e4567-e89b-12d3-a456-426614174000",
    };
    expect(factoryActionRequestSchema.parse(preview)).toEqual(preview);
    expect(() => factoryActionRequestSchema.parse({ ...preview, expectedRevision: null })).toThrow();

    const integrationReport = {
      repositoryKey: "monorepo",
      action: { kind: "integration-report" },
      idempotencyKey: "bbf:v1:monorepo:integration-report:123e4567-e89b-12d3-a456-426614174000",
    };
    expect(factoryActionRequestSchema.parse(integrationReport)).toEqual(integrationReport);
  });

  it("binds idempotency repository and action segments to the request", () => {
    const request = {
      repositoryKey: "monorepo",
      action: { kind: "run-now" },
      idempotencyKey: "bbf:v1:monorepo:run-now:123e4567-e89b-12d3-a456-426614174000",
      expectedRevision: repositoryRevision,
    };

    expect(factoryActionRequestSchema.parse(request)).toEqual(request);
    expect(() => factoryActionRequestSchema.parse({
      ...request,
      idempotencyKey: "bbf:v1:other-repo:run-now:123e4567-e89b-12d3-a456-426614174000",
    })).toThrow();
    expect(() => factoryActionRequestSchema.parse({
      ...request,
      idempotencyKey: "bbf:v1:monorepo:pause:123e4567-e89b-12d3-a456-426614174000",
    })).toThrow();
  });

  it("represents stale writes as structured domain errors", () => {
    const error = {
      category: "stale-revision",
      message: "The repository changed before this action was applied.",
      expectedRevision: repositoryRevision,
      actualRevision: { ...repositoryRevision, protocolDigest: "c".repeat(64) },
    };

    expect(factoryErrorSchema.parse(error)).toEqual(error);
    expect(staleRevisionErrorVariantSchema.parse(error)).toEqual(error);
    expect(
      () => factoryErrorSchema.parse({ ...error, actualRevision: undefined }),
    ).toThrow();
    expect(
      () => factoryErrorSchema.parse({ category: "conflict", message: "Conflict", expectedRevision: repositoryRevision }),
    ).toThrow();
    expect(
      factoryActionResultSchema.parse({ ok: false, error }),
    ).toEqual({ ok: false, error });
  });

  it("marks realtime signals as invalidation-only", () => {
    const event = {
      channel: "factory",
      kind: "repository.changed",
      repositoryKey: "monorepo",
      revision: repositoryRevision,
      reason: "repository write committed",
      durableReloadRequired: true,
    };

    expect(invalidationEventSchema.parse(event)).toEqual(event);
  });

  it("validates read projections for selection, settings, health, and runs", () => {
    const configuration = {
      repositoryKey: "monorepo",
      repositoryRoot: "/workspace/monorepo",
      connectedHostId: "macbook",
      checkoutPath: "/workspace/monorepo-factory",
      factoryBranch: "factory",
      mainRef: "origin/main",
    };
    expect(repositorySelectionInputSchema.parse({})).toEqual({});
    expect(
      repositorySelectionProjectionSchema.parse({
        repositories: [{ configuration, selected: true, available: true, reasons: [] }],
        selectedRepositoryKey: "monorepo",
      }).selectedRepositoryKey,
    ).toBe("monorepo");

    expect(
      settingsProjectionSchema.parse({
        settings: { dispatchMode: "paused", minimumStartGapSeconds: 3600 },
        validation: { valid: true, fieldErrors: {} },
        dispatch: { mode: "paused", acceptingNewRuns: false, activeRunCount: 0, reason: "paused by configuration" },
      }).validation.valid,
    ).toBe(true);

    expect(
      healthProjectionSchema.parse({
        repositoryKey: "monorepo",
        providers: [],
        host: {
          hostId: "macbook",
          status: "unknown",
          checkoutExists: false,
          branch: null,
          requiredTools: {},
          browserAvailable: null,
          dbtStudioAvailable: null,
          ok: false,
          reasons: ["preflight not run"],
        },
      }).providers,
    ).toEqual([]);
  });

  it("validates operational run list and detail linkage to canonical records", () => {
    const summary = {
      runId: "run-1",
      repositoryKey: "monorepo",
      status: "completed",
      requestedAt: "2026-09-10T00:00:00Z",
      startedAt: "2026-09-10T00:01:00Z",
      finishedAt: "2026-09-10T00:02:00Z",
      providerId: "codex",
      workerThreadId: "thread-1",
      projectId: "project-1",
      environmentId: "environment-1",
      queueItemIds: ["Q1"],
      repositoryRevision,
      canonicalRecords: [{
        relativePath: "plans/factory/current.md",
        recordType: "current-run",
        recordId: "run-1",
        repositoryRevision,
      }],
    };
    expect(operationalRunListInputSchema.parse({ repositoryKey: "monorepo" }).limit).toBe(50);
    expect(operationalRunDetailInputSchema.parse({ repositoryKey: "monorepo", runId: "run-1" }).runId).toBe("run-1");
    expect(operationalRunListProjectionSchema.parse({ runs: [summary], nextCursor: null }).runs[0]).toEqual(summary);
    expect(
      operationalRunListProjectionSchema.parse({
        runs: [{ ...summary, status: "pending", projectId: null, environmentId: null }],
        nextCursor: null,
      }).runs[0].projectId,
    ).toBeNull();
    expect(
      () => operationalRunListProjectionSchema.parse({
        runs: [{ ...summary, projectId: null }],
        nextCursor: null,
      }),
    ).toThrow();
    expect(operationalRunDetailProjectionSchema.parse({ run: null })).toEqual({ run: null });
  });

  it("separates repository questions from exactly-once BB interaction answers", () => {
    const pending = {
      source: "bb-interaction",
      interactionId: "interaction-1",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "pending",
      kind: "user-question",
      title: "Choose a provider",
      prompt: "Which provider should run?",
      createdAt: "2026-09-10T00:00:00Z",
      expiresAt: null,
    };
    expect(
      pendingInteractionsProjectionSchema.parse({ repositoryKey: "monorepo", interactions: [pending] }).interactions[0],
    ).toEqual(pending);

    const repositoryAnswer = {
      repositoryKey: "monorepo",
      action: { kind: "answer-question", source: "repository-question", questionId: "Q6", answer: "Use Codex." },
      idempotencyKey: "bbf:v1:monorepo:answer-question:123e4567-e89b-12d3-a456-426614174000",
      expectedRevision: repositoryRevision,
    };
    expect(repositoryActionRequestSchema.parse(repositoryAnswer)).toEqual(repositoryAnswer);

    const interactionAnswer = {
      repositoryKey: "monorepo",
      action: { kind: "answer-question", source: "bb-interaction", interactionId: "interaction-1", value: { selected: "codex" } },
      idempotencyKey: "bbf:v1:monorepo:answer-question:223e4567-e89b-12d3-a456-426614174000",
      expectedRevision: repositoryRevision,
    };
    expect(bbInteractionActionRequestSchema.parse(interactionAnswer)).toEqual(interactionAnswer);
    expect(factoryActionRequestSchema.parse(interactionAnswer)).toEqual(interactionAnswer);
    const bbOutcome = {
      action: "answer-question",
      status: "accepted",
      message: "BB interaction answered.",
      revision: repositoryRevision,
      runId: null,
      leaseId: null,
      questionId: null,
      interactionId: "interaction-1",
      queueItemId: null,
      source: "bb-interaction",
    };
    const parsedBbResult = factoryActionResultSchema.parse({
      ok: true,
      result: bbOutcome,
      revision: repositoryRevision,
    });
    if (!parsedBbResult.ok) throw new Error("expected a successful BB action result");
    expect(parsedBbResult.result.interactionId).toBe("interaction-1");

    const repositoryOutcome = {
      ...bbOutcome,
      message: "Repository question answered.",
      source: "repository-question",
      questionId: "Q6",
      interactionId: null,
    };
    const parsedRepositoryResult = factoryActionResultSchema.parse({
      ok: true,
      result: repositoryOutcome,
      revision: repositoryRevision,
    });
    if (!parsedRepositoryResult.ok) throw new Error("expected a successful repository action result");
    expect(parsedRepositoryResult.result.questionId).toBe("Q6");

    expect(() => factoryActionResultSchema.parse({
      ok: true,
      result: { ...bbOutcome, interactionId: null },
      revision: repositoryRevision,
    })).toThrow();
    expect(() => factoryActionResultSchema.parse({
      ok: true,
      result: { ...bbOutcome, questionId: "Q6" },
      revision: repositoryRevision,
    })).toThrow();
    expect(() => factoryActionResultSchema.parse({
      ok: true,
      result: { ...repositoryOutcome, questionId: null },
      revision: repositoryRevision,
    })).toThrow();
    expect(() => factoryActionResultSchema.parse({
      ok: true,
      result: { ...repositoryOutcome, interactionId: "interaction-1" },
      revision: repositoryRevision,
    })).toThrow();
    expect(
      () => bbInteractionActionRequestSchema.parse({
        ...interactionAnswer,
        action: { ...interactionAnswer.action, interactionId: "" },
      }),
    ).toThrow();
  });
});
