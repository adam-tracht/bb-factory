import { describe, expect, it } from "vitest";
import {
  bbInteractionResolutionSchema,
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
  pendingInteractionMetadataSchema,
  questionSchema,
  queueStatusSchema,
  repositorySelectionInputSchema,
  repositorySelectionProjectionSchema,
  repositoryRegistrySchema,
  resolveRepositoryRegistry,
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

const monorepoRegistryEntry = {
  configuration: {
    repositoryKey: "monorepo",
    repositoryRoot: "/workspace/monorepo",
    connectedHostId: "host-1",
    checkoutPath: "/workspace/monorepo/.factory",
    factoryBranch: "factory",
    mainRef: "origin/main",
  },
  projectId: "project-monorepo",
  environmentId: "environment-monorepo",
};

const dataRegistryEntry = {
  configuration: {
    repositoryKey: "data-platform",
    repositoryRoot: "/workspace/data-platform",
    connectedHostId: "host-1",
    checkoutPath: "/workspace/data-platform/.factory",
    factoryBranch: "factory",
    mainRef: "origin/main",
  },
  projectId: "project-data",
  environmentId: "environment-data",
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

  it("validates a typed multi-repository registry through the SDK JSON setting", () => {
    const registry = {
      repositories: [monorepoRegistryEntry, dataRegistryEntry],
      defaultRepositoryKey: "monorepo",
    };
    const encoded = JSON.stringify(registry);

    expect(repositoryRegistrySchema.parse(registry)).toEqual(registry);
    expect(factorySettingDescriptors.repositoryRegistry.experimental_schema.parse(encoded)).toBe(encoded);
    expect(() => factorySettingDescriptors.repositoryRegistry.experimental_schema.parse(JSON.stringify({
      ...registry,
      secrets: { token: "hidden" },
    }))).toThrow();
    expect(factorySettingsSchema.parse({ repositoryRegistry: encoded }).repositoryRegistry).toEqual(registry);
    expect(resolveRepositoryRegistry(factorySettingsSchema.parse({
      repositoryRegistry: encoded,
      repositoryKey: "data-platform",
    }))).toMatchObject({
      status: "configured",
      source: "registry",
      selectedRepositoryKey: "data-platform",
      repositories: [monorepoRegistryEntry, dataRegistryEntry],
    });
  });

  it("rejects duplicate repository keys and invalid selected keys", () => {
    const registry = {
      repositories: [monorepoRegistryEntry, dataRegistryEntry],
      defaultRepositoryKey: "monorepo",
    };
    expect(() => repositoryRegistrySchema.parse({
      ...registry,
      repositories: [
        registry.repositories[0],
        { ...registry.repositories[1], configuration: { ...registry.repositories[1].configuration, repositoryKey: "monorepo" } },
      ],
    })).toThrow();
    expect(() => repositoryRegistrySchema.parse({ ...registry, defaultRepositoryKey: "missing" })).toThrow();
    expect(() => factorySettingsSchema.parse({ repositoryRegistry: registry, repositoryKey: "missing" })).toThrow();
    expect(() => repositoryRegistrySchema.parse({
      ...registry,
      repositories: [{ ...registry.repositories[0], projectId: "" }, registry.repositories[1]],
    })).toThrow();
  });

  it("migrates a complete single-repository setting and disables incomplete legacy values", () => {
    const legacyValues = {
      repositoryKey: "monorepo",
      repositoryRoot: "/workspace/monorepo",
      connectedHostId: "host-1",
      checkoutPath: "/workspace/monorepo/.factory",
      projectId: "project-monorepo",
      environmentId: "environment-monorepo",
    };
    const descriptorDefaults = {
      timeZone: factorySettingDescriptors.timeZone.default,
      nightWindowEndHour: factorySettingDescriptors.nightWindowEndHour.default,
      runtimeCapSeconds: factorySettingDescriptors.runtimeCapSeconds.default,
      minimumStartGapSeconds: factorySettingDescriptors.minimumStartGapSeconds.default,
      concurrencyLimit: factorySettingDescriptors.concurrencyLimit.default,
      dispatchMode: factorySettingDescriptors.dispatchMode.default,
    };
    expect("default" in factorySettingDescriptors.repositoryRegistry).toBe(false);
    const migrated = resolveRepositoryRegistry(factorySettingsSchema.parse({
      ...descriptorDefaults,
      ...legacyValues,
    }));
    expect(migrated).toEqual({
      status: "configured",
      source: "legacy",
      repositories: [monorepoRegistryEntry],
      selectedRepositoryKey: "monorepo",
    });

    const incomplete = resolveRepositoryRegistry(factorySettingsSchema.parse({
      repositoryKey: "monorepo",
      repositoryRoot: "/workspace/monorepo",
      connectedHostId: "host-1",
      checkoutPath: "/workspace/monorepo/.factory",
    }));
    expect(incomplete).toMatchObject({ status: "disabled", source: "legacy", reason: "legacy-incomplete" });

    const explicitEmpty = resolveRepositoryRegistry(factorySettingsSchema.parse({
      repositoryRegistry: JSON.stringify({ repositories: [], defaultRepositoryKey: null }),
      ...legacyValues,
    }));
    expect(explicitEmpty).toEqual({
      status: "disabled",
      source: "registry",
      reason: "explicitly-empty",
      repositories: [],
      selectedRepositoryKey: null,
    });
  });

  it("keeps disabled defaults paused with no provider pin or configured registry", () => {
    const defaults = factorySettingsSchema.parse({});
    expect(defaults.dispatchMode).toBe("paused");
    expect(defaults.providerPreference).toBeUndefined();
    expect(resolveRepositoryRegistry(defaults)).toEqual({
      status: "disabled",
      source: "none",
      reason: "not-configured",
      repositories: [],
      selectedRepositoryKey: null,
    });
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
      metadata: {
        kind: "user_question",
        questions: [{
          id: "provider",
          prompt: "Which provider should run?",
          shortLabel: "Provider",
          allowFreeText: false,
          multiSelect: false,
          options: [
            { value: "provider-codex", label: "Codex" },
            { value: "provider-claude", label: "Claude" },
          ],
        }],
      },
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
      action: {
        kind: "answer-question",
        source: "bb-interaction",
        interactionId: "interaction-1",
        resolution: {
          kind: "user_answer",
          answers: {
            provider: { selected: ["provider-codex"] },
          },
        },
      },
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

  it("preserves native question metadata and uses option values, not labels", () => {
    const metadata = {
      kind: "user_question",
      questions: [{
        id: "deployment-target",
        prompt: "Where should this deploy?",
        shortLabel: "Target",
        allowFreeText: true,
        multiSelect: true,
        options: [
          { label: "Production Europe", value: "prod-eu", description: "EU production" },
          { label: "Production US", value: "prod-us", description: "US production" },
        ],
      }],
    };
    expect(pendingInteractionMetadataSchema.parse(metadata)).toEqual(metadata);

    const resolution = {
      kind: "user_answer",
      answers: {
        "deployment-target": {
          selected: ["prod-eu", "prod-us"],
          freeText: "include the canary account",
        },
        "another-question": { selected: ["staging"] },
      },
    };
    expect(bbInteractionResolutionSchema.parse(resolution)).toEqual(resolution);
    expect(() => pendingInteractionMetadataSchema.parse({
      ...metadata,
      questions: [{ ...metadata.questions[0], options: [{ label: "Production Europe" }] }],
    })).toThrow();
    expect(resolution.answers["deployment-target"].selected).toEqual(["prod-eu", "prod-us"]);
    expect(resolution.answers["deployment-target"].selected).not.toContain("Production Europe");
    expect(() => bbInteractionResolutionSchema.parse({
      ...resolution,
      answers: { "deployment-target": { selected: ["prod-eu"], freeText: 42 } },
    })).toThrow();
  });

  it("normalizes namespaced provider custom requests without exposing data", () => {
    const sdkProviderCustomRequest = {
      kind: "acme/factory-checkpoint",
      title: "Factory checkpoint",
      data: { secret: "do-not-return-this", grant: { token: "hidden" } },
    };
    const normalized = {
      source: "bb-interaction",
      interactionId: "interaction-plugin",
      threadId: "thread-1",
      turnId: null,
      status: "pending",
      kind: "plugin",
      metadata: { kind: "plugin" },
      title: sdkProviderCustomRequest.title,
      prompt: null,
      createdAt: "2026-09-10T00:00:00Z",
      expiresAt: null,
    };

    const parsed = pendingInteractionsProjectionSchema.parse({ repositoryKey: "monorepo", interactions: [normalized] });
    expect(parsed.interactions[0]).toEqual(normalized);
    expect(JSON.stringify(parsed)).not.toContain("do-not-return-this");
    expect(() => pendingInteractionsProjectionSchema.parse({
      repositoryKey: "monorepo",
      interactions: [{ ...normalized, kind: sdkProviderCustomRequest.kind, data: sdkProviderCustomRequest.data }],
    })).toThrow();
    expect(() => pendingInteractionMetadataSchema.parse({ kind: "plugin", data: sdkProviderCustomRequest.data })).toThrow();
  });

  it("correlates the normalized top-level kind with metadata.kind", () => {
    const common = {
      source: "bb-interaction",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "pending",
      prompt: null,
      createdAt: "2026-09-10T00:00:00Z",
      expiresAt: null,
    };
    const approval = {
      ...common,
      interactionId: "interaction-approval",
      kind: "approval",
      metadata: { kind: "approval", availableDecisions: ["allow_once", "deny"] },
      title: "BB approval required",
    };
    const userQuestion = {
      ...common,
      interactionId: "interaction-question",
      kind: "user-question",
      metadata: {
        kind: "user_question",
        questions: [{
          id: "provider",
          prompt: "Which provider should run?",
          allowFreeText: false,
          multiSelect: false,
          options: [{ label: "Codex", value: "provider-codex" }],
        }],
      },
      title: "Provider",
    };
    const plugin = {
      ...common,
      interactionId: "interaction-plugin",
      turnId: null,
      kind: "plugin",
      metadata: { kind: "plugin" },
      title: "Factory checkpoint",
    };

    expect(
      pendingInteractionsProjectionSchema.parse({
        repositoryKey: "monorepo",
        interactions: [approval, userQuestion, plugin],
      }).interactions,
    ).toHaveLength(3);

    const mismatchedPairs = [
      { ...approval, metadata: userQuestion.metadata },
      { ...approval, metadata: plugin.metadata },
      { ...userQuestion, metadata: approval.metadata },
      { ...userQuestion, metadata: plugin.metadata },
      { ...plugin, metadata: approval.metadata },
      { ...plugin, metadata: userQuestion.metadata },
    ];
    for (const interaction of mismatchedPairs) {
      expect(() => pendingInteractionsProjectionSchema.parse({
        repositoryKey: "monorepo",
        interactions: [interaction],
      })).toThrow();
    }
  });

  it("accepts only the bounded native approval decisions", () => {
    for (const decision of ["allow_once", "allow_for_session", "deny"] as const) {
      expect(bbInteractionResolutionSchema.parse({ kind: "approval", decision })).toEqual({ kind: "approval", decision });
      expect(pendingInteractionMetadataSchema.parse({ kind: "approval", availableDecisions: [decision] })).toEqual({
        kind: "approval",
        availableDecisions: [decision],
      });
    }
    expect(() => bbInteractionResolutionSchema.parse({ kind: "approval", decision: "allow" })).toThrow();
    expect(() => bbInteractionResolutionSchema.parse({ kind: "approval", decision: "deny", grantedPermissions: null })).toThrow();
    expect(() => bbInteractionResolutionSchema.parse({ kind: "request_answer", value: { arbitrary: true } })).toThrow();
  });
});
