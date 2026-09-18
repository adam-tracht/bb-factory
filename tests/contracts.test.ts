import { describe, expect, it } from "vitest";
import {
  actionOutcomeSchema,
  addRepositoryInputSchema,
  bbInteractionResolutionSchema,
  bbInteractionActionRequestSchema,
  factoryActionRequestSchema,
  factoryActionResultSchema,
  factoryErrorSchema,
  factorySettingsSchema,
  factorySettingsPatchSchema,
  healthProjectionSchema,
  invalidationEventSchema,
  idempotencyKeySchema,
  operationalRunDetailInputSchema,
  operationalRunDetailProjectionSchema,
  operationalRunListInputSchema,
  operationalRunListProjectionSchema,
  pendingInteractionsProjectionSchema,
  pendingInteractionMetadataSchema,
  pickFolderInputSchema,
  pickFolderResultSchema,
  providerPreferenceSchema,
  providerStatusSchema,
  repositoryDisplayNameSchema,
  probeRepositoryInputSchema,
  questionSchema,
  repositoryProbeSchema,
  resolveProjectInputSchema,
  resolveProjectResultSchema,
  queueStatusSchema,
  repositorySelectionInputSchema,
  repositorySelectionProjectionSchema,
  repositoryRegistrySchema,
  resolveRepositoryRegistry,
  repositoryActionRequestSchema,
  updateRepositoryInputSchema,
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

  it("accepts arbitrary provider ids while rejecting malformed preferences", () => {
    expect(providerPreferenceSchema.parse("acp-opencode")).toBe("acp-opencode");
    expect(providerPreferenceSchema.parse("alternate")).toBe("alternate");
    expect(() => providerPreferenceSchema.parse("ACP-OpenCode")).toThrow();
    expect(() => providerPreferenceSchema.parse("acp opencode")).toThrow();
  });

  it("keeps provider status permission modes optional for stored health values", () => {
    const status = {
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      availability: "available",
      limitedUntil: null,
      activeThreadCount: 0,
      lastError: null,
    } as const;
    expect(providerStatusSchema.parse(status)).toEqual(status);
    expect(providerStatusSchema.parse({ ...status, permissionModes: ["full"] })).toMatchObject({ permissionModes: ["full"] });
  });

  it("describes provider preference as a host-reported string", () => {
    expect(factorySettingDescriptors.providerPreference.type).toBe("string");
    expect("options" in factorySettingDescriptors.providerPreference).toBe(false);
  });

  it("parses stored provider model defaults from the JSON settings string", () => {
    const defaults = { codex: { model: "gpt-5-codex", reasoningLevel: "high" } };
    const encoded = JSON.stringify(defaults);

    expect(factorySettingsSchema.parse({ providerModelDefaults: encoded }).providerModelDefaults).toEqual(defaults);
    // The already-parsed projection form round-trips through the same field.
    expect(factorySettingsSchema.parse({ providerModelDefaults: defaults }).providerModelDefaults).toEqual(defaults);
    expect(factorySettingDescriptors.providerModelDefaults.experimental_schema.parse(encoded)).toBe(encoded);
    expect(() => factorySettingsSchema.parse({
      providerModelDefaults: JSON.stringify({ codex: { model: "gpt-5-codex", reasoningLevel: "ludicrous" } }),
    })).toThrow();
    expect(() => factorySettingsSchema.parse({
      providerModelDefaults: JSON.stringify({ codex: { model: "", reasoningLevel: "high" } }),
    })).toThrow();
    expect(() => factorySettingDescriptors.providerModelDefaults.experimental_schema.parse("not json")).toThrow();
    expect(factorySettingsSchema.parse({}).providerModelDefaults).toBeUndefined();
  });

  it("takes a full provider model defaults map or null in a settings patch", () => {
    const defaults = { codex: { model: "gpt-5-codex", reasoningLevel: "high" } };
    expect(factorySettingsPatchSchema.parse({ providerModelDefaults: defaults }).providerModelDefaults).toEqual(defaults);
    expect(factorySettingsPatchSchema.parse({ providerModelDefaults: null }).providerModelDefaults).toBeNull();
    expect(factorySettingsPatchSchema.parse({ providerModelDefaults: {} }).providerModelDefaults).toEqual({});
    expect(() => factorySettingsPatchSchema.parse({
      providerModelDefaults: { codex: { model: "gpt-5-codex", reasoningLevel: "ludicrous" } },
    })).toThrow();
    expect(() => factorySettingsPatchSchema.parse({
      providerModelDefaults: { "Bad Provider": { model: "gpt-5-codex", reasoningLevel: "high" } },
    })).toThrow();
  });

  it("parses a stored provider rotation from the JSON settings string", () => {
    const rotation = ["codex", "claude-code", "acp-devin"];
    const encoded = JSON.stringify(rotation);

    expect(factorySettingsSchema.parse({ providerRotation: encoded }).providerRotation).toEqual(rotation);
    // The already-parsed projection form round-trips through the same field.
    expect(factorySettingsSchema.parse({ providerRotation: rotation }).providerRotation).toEqual(rotation);
    expect(factorySettingDescriptors.providerRotation.experimental_schema.parse(encoded)).toBe(encoded);
    expect(() => factorySettingsSchema.parse({ providerRotation: JSON.stringify(["codex"]) })).toThrow();
    expect(() => factorySettingsSchema.parse({ providerRotation: JSON.stringify(["codex", "codex"]) })).toThrow();
    expect(() => factorySettingsSchema.parse({
      providerRotation: JSON.stringify(["codex", "claude-code", "acp-devin", "acp-opencode", "pi", "amp"]),
    })).toThrow();
    expect(() => factorySettingsSchema.parse({ providerRotation: JSON.stringify(["codex", "Bad Id"]) })).toThrow();
    expect(() => factorySettingDescriptors.providerRotation.experimental_schema.parse("not json")).toThrow();
    expect(factorySettingsSchema.parse({}).providerRotation).toBeUndefined();
  });

  it("takes a provider rotation list or null in a settings patch", () => {
    expect(factorySettingsPatchSchema.parse({ providerRotation: ["codex", "claude-code"] }).providerRotation)
      .toEqual(["codex", "claude-code"]);
    expect(factorySettingsPatchSchema.parse({ providerRotation: null }).providerRotation).toBeNull();
    expect(() => factorySettingsPatchSchema.parse({ providerRotation: ["codex"] })).toThrow();
    expect(() => factorySettingsPatchSchema.parse({ providerRotation: ["codex", "codex"] })).toThrow();
    expect(() => factorySettingsPatchSchema.parse({ providerRotation: ["codex", "Bad Id"] })).toThrow();
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

  it("accepts a registry entry without an environment id", () => {
    const unmanagedEntry = {
      configuration: monorepoRegistryEntry.configuration,
      projectId: monorepoRegistryEntry.projectId,
    };
    const registry = {
      repositories: [unmanagedEntry],
      defaultRepositoryKey: "monorepo",
    };
    expect(repositoryRegistrySchema.parse(registry)).toEqual(registry);
    expect(resolveRepositoryRegistry(factorySettingsSchema.parse({ repositoryRegistry: registry }))).toMatchObject({
      status: "configured",
      source: "registry",
      selectedRepositoryKey: "monorepo",
      repositories: [unmanagedEntry],
    });
    expect(addRepositoryInputSchema.parse({
      configuration: {
        repositoryKey: "monorepo",
        repositoryRoot: "/workspace/monorepo",
        connectedHostId: "host-1",
        checkoutPath: "/workspace/monorepo/.factory",
      },
      projectId: "project-monorepo",
    })).toMatchObject({ projectId: "project-monorepo", dispatchPaused: true });
  });

  it("keeps display names optional, normalized, and outside repository identity", () => {
    expect(repositoryDisplayNameSchema.parse("x".repeat(64))).toBe("x".repeat(64));
    expect(repositoryDisplayNameSchema.parse(" \t Friendly name \n")).toBe("Friendly name");
    expect(() => repositoryDisplayNameSchema.parse(" \t \n")).toThrow();
    expect(() => repositoryDisplayNameSchema.parse("x".repeat(65))).toThrow();
    const registry = {
      repositories: [
        { ...monorepoRegistryEntry, displayName: "  Core monorepo  " },
        { ...dataRegistryEntry, displayName: "Core monorepo" },
      ],
      defaultRepositoryKey: "monorepo",
    };
    const parsed = repositoryRegistrySchema.parse(registry);
    expect(parsed.repositories.map((entry) => entry.displayName)).toEqual(["Core monorepo", "Core monorepo"]);
    expect(parsed.repositories[0]?.configuration).not.toHaveProperty("displayName");
    expect(addRepositoryInputSchema.parse({
      configuration: {
        repositoryKey: monorepoRegistryEntry.configuration.repositoryKey,
        repositoryRoot: monorepoRegistryEntry.configuration.repositoryRoot,
        connectedHostId: monorepoRegistryEntry.configuration.connectedHostId,
        checkoutPath: monorepoRegistryEntry.configuration.checkoutPath,
        mainRef: monorepoRegistryEntry.configuration.mainRef,
      },
      projectId: monorepoRegistryEntry.projectId,
      displayName: "  Friendly name  ",
    }).displayName).toBe("Friendly name");
    expect(updateRepositoryInputSchema.parse({
      repositoryKey: "monorepo",
      displayName: "  Updated name  ",
    })).toEqual({ repositoryKey: "monorepo", displayName: "Updated name" });
    expect(updateRepositoryInputSchema.parse({ repositoryKey: "monorepo", displayName: null })).toEqual({
      repositoryKey: "monorepo",
      displayName: null,
    });
    expect(() => updateRepositoryInputSchema.parse({ repositoryKey: "monorepo" })).toThrow();
    expect(() => addRepositoryInputSchema.parse({
      configuration: {
        repositoryKey: monorepoRegistryEntry.configuration.repositoryKey,
        repositoryRoot: monorepoRegistryEntry.configuration.repositoryRoot,
        connectedHostId: monorepoRegistryEntry.configuration.connectedHostId,
        checkoutPath: monorepoRegistryEntry.configuration.checkoutPath,
        mainRef: monorepoRegistryEntry.configuration.mainRef,
      },
      projectId: monorepoRegistryEntry.projectId,
      displayName: "x".repeat(65),
    })).toThrow();
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

    const withoutEnvironment = resolveRepositoryRegistry(factorySettingsSchema.parse({
      repositoryKey: "monorepo",
      repositoryRoot: "/workspace/monorepo",
      connectedHostId: "host-1",
      checkoutPath: "/workspace/monorepo/.factory",
      projectId: "project-monorepo",
    }));
    expect(withoutEnvironment).toMatchObject({
      status: "configured",
      source: "legacy",
      repositories: [{ configuration: { repositoryKey: "monorepo" }, projectId: "project-monorepo" }],
      selectedRepositoryKey: "monorepo",
    });
    expect(withoutEnvironment.status === "configured" && withoutEnvironment.repositories[0]!.environmentId).toBeUndefined();

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

  it("requires revisions for repository file actions, tolerates omitted revisions for BB-side actions, and scopes revision-free actions", () => {
    const request = {
      repositoryKey: "monorepo",
      action: { kind: "run-now" },
      idempotencyKey: "bbf:v1:monorepo:run-now:123e4567-e89b-12d3-a456-426614174000",
      expectedRevision: repositoryRevision,
    };

    expect(factoryActionRequestSchema.parse(request)).toEqual(request);
    // BB-side actions stay usable when the protocol snapshot cannot load.
    expect(factoryActionRequestSchema.parse({ repositoryKey: request.repositoryKey, action: request.action, idempotencyKey: request.idempotencyKey }))
      .toMatchObject({ action: { kind: "run-now" } });
    expect(() => factoryActionRequestSchema.parse({ ...request, expectedRevision: null })).toThrow();

    const approval = {
      repositoryKey: "monorepo",
      action: { kind: "approve-queue", queueItemId: "A-1", approvedText: "ok" },
      idempotencyKey: "bbf:v1:monorepo:approve-queue:123e4567-e89b-12d3-a456-426614174000",
      expectedRevision: repositoryRevision,
    };
    expect(factoryActionRequestSchema.parse(approval)).toEqual(approval);
    expect(() => factoryActionRequestSchema.parse({ repositoryKey: approval.repositoryKey, action: approval.action, idempotencyKey: approval.idempotencyKey })).toThrow();

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

    const recommend = {
      repositoryKey: "monorepo",
      action: { kind: "recommend-question", questionId: "Q6", providerId: "claude-code", model: "claude-sonnet-4", reasoningLevel: "high" },
      idempotencyKey: "bbf:v1:monorepo:recommend-question:123e4567-e89b-12d3-a456-426614174000",
      expectedRevision: repositoryRevision,
    };
    expect(factoryActionRequestSchema.parse(recommend)).toEqual(recommend);
    expect(() => factoryActionRequestSchema.parse({
      ...recommend,
      action: { ...recommend.action, providerId: "Not A Provider" },
    })).toThrow();

    const recommendApproval = {
      repositoryKey: "monorepo",
      action: { kind: "recommend-approval", queueItemId: "A-1", providerId: "claude-code", model: "claude-sonnet-4", reasoningLevel: "high", serviceTier: "fast" },
      idempotencyKey: "bbf:v1:monorepo:recommend-approval:223e4567-e89b-12d3-a456-426614174000",
      expectedRevision: repositoryRevision,
    };
    expect(factoryActionRequestSchema.parse(recommendApproval)).toEqual(recommendApproval);
    expect(() => factoryActionRequestSchema.parse({
      ...recommendApproval,
      action: { ...recommendApproval.action, queueItemId: "" },
    })).toThrow();
  });

  it("accepts a full run-now provider override and rejects partial triples", () => {
    const request = (action: Record<string, unknown>) => ({
      repositoryKey: "monorepo",
      action,
      idempotencyKey: "bbf:v1:monorepo:run-now:123e4567-e89b-12d3-a456-426614174000",
      expectedRevision: repositoryRevision,
    });

    const full = { kind: "run-now", providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "high", serviceTier: "fast" };
    expect(factoryActionRequestSchema.parse(request(full))).toEqual(request(full));
    expect(factoryActionRequestSchema.parse(request({ kind: "run-now" }))).toEqual(request({ kind: "run-now" }));
    // serviceTier rides alone; only the provider/model/reasoning triple is all-or-none.
    expect(factoryActionRequestSchema.parse(request({ kind: "run-now", serviceTier: "fast" })))
      .toMatchObject({ action: { kind: "run-now", serviceTier: "fast" } });

    for (const action of [
      { kind: "run-now", providerId: "codex" },
      { kind: "run-now", providerId: "codex", model: "gpt-5" },
      { kind: "run-now", model: "gpt-5", reasoningLevel: "high" },
      { kind: "run-now", reasoningLevel: "high" },
      { kind: "run-now", providerId: "codex", reasoningLevel: "high" },
      { kind: "run-now", providerId: "codex", model: "gpt-5", reasoningLevel: "high", extra: true },
      { kind: "run-now", providerId: "Not A Provider", model: "gpt-5", reasoningLevel: "high" },
    ]) {
      expect(() => factoryActionRequestSchema.parse(request(action))).toThrow();
    }
  });

  it("accepts draft-tasks with a goal alone or a full provider pin, and rejects malformed variants", () => {
    const request = (action: Record<string, unknown>) => ({
      repositoryKey: "monorepo",
      action,
      idempotencyKey: "bbf:v1:monorepo:draft-tasks:323e4567-e89b-12d3-a456-426614174000",
      expectedRevision: repositoryRevision,
    });

    const goalOnly = { kind: "draft-tasks", goal: "Break the hosting rollout into tasks" };
    expect(factoryActionRequestSchema.parse(request(goalOnly))).toEqual(request(goalOnly));

    const full = {
      kind: "draft-tasks",
      goal: "Break the hosting rollout into tasks",
      planPath: "docs/hosting-decision.md",
      providerId: "claude-code",
      model: "claude-sonnet-4",
      reasoningLevel: "high",
      serviceTier: "fast",
    };
    expect(factoryActionRequestSchema.parse(request(full))).toEqual(request(full));
    // serviceTier rides alone; only the provider/model/reasoning triple is all-or-none.
    expect(factoryActionRequestSchema.parse(request({ kind: "draft-tasks", goal: "g", serviceTier: "fast" })))
      .toMatchObject({ action: { kind: "draft-tasks", serviceTier: "fast" } });

    for (const action of [
      { kind: "draft-tasks" },
      { kind: "draft-tasks", goal: "" },
      { kind: "draft-tasks", goal: "   " },
      { kind: "draft-tasks", goal: "g", providerId: "codex" },
      { kind: "draft-tasks", goal: "g", providerId: "codex", model: "gpt-5" },
      { kind: "draft-tasks", goal: "g", model: "gpt-5", reasoningLevel: "high" },
      { kind: "draft-tasks", goal: "g", extra: true },
      { kind: "draft-tasks", goal: "g", providerId: "Not A Provider", model: "gpt-5", reasoningLevel: "high" },
    ]) {
      expect(() => factoryActionRequestSchema.parse(request(action))).toThrow();
    }
  });

  it("carries the spawned thread id on accepted recommendation outcomes", () => {
    const outcome = {
      status: "accepted",
      message: "Started a recommendation chat.",
      revision: repositoryRevision,
      runId: null,
      leaseId: null,
      queueItemId: null,
      action: "recommend-question",
      questionId: "Q6",
      interactionId: null,
      threadId: "thr_rec",
    };
    expect(actionOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(factoryActionResultSchema.parse({ ok: true, revision: repositoryRevision, result: outcome }))
      .toEqual({ ok: true, revision: repositoryRevision, result: outcome });
    const missingThread = { ...outcome };
    delete (missingThread as Record<string, unknown>).threadId;
    expect(() => actionOutcomeSchema.parse(missingThread)).toThrow();

    const approvalOutcome = {
      status: "accepted",
      message: "Started an approval-drafting chat.",
      revision: repositoryRevision,
      runId: null,
      leaseId: null,
      queueItemId: "A-1",
      action: "recommend-approval",
      interactionId: null,
      threadId: "thr_approval",
    };
    expect(actionOutcomeSchema.parse(approvalOutcome)).toEqual(approvalOutcome);

    const draftOutcome = {
      status: "accepted",
      message: "Started a queue-drafting chat.",
      revision: repositoryRevision,
      runId: null,
      leaseId: null,
      queueItemId: null,
      action: "draft-tasks",
      questionId: null,
      interactionId: null,
      threadId: "thr_draft",
    };
    expect(actionOutcomeSchema.parse(draftOutcome)).toEqual(draftOutcome);
    const draftMissingThread = { ...draftOutcome };
    delete (draftMissingThread as Record<string, unknown>).threadId;
    expect(() => actionOutcomeSchema.parse(draftMissingThread)).toThrow();
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
        repositories: [{ configuration, projectId: "project-1", environmentId: "environment-1", dispatchPaused: false, selected: true, available: true, reasons: [] }],
        selectedRepositoryKey: "monorepo",
      }).selectedRepositoryKey,
    ).toBe("monorepo");

    expect(
      settingsProjectionSchema.parse({
        settings: { dispatchMode: "paused", minimumStartGapSeconds: 3600 },
        validation: { valid: true, fieldErrors: {} },
        dispatch: { mode: "paused", repositoryPaused: false, acceptingNewRuns: false, activeRunCount: 0, reason: "paused by configuration" },
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
    if (parsedRepositoryResult.result.action !== "answer-question" || parsedRepositoryResult.result.source !== "repository-question") {
      throw new Error("expected a repository question outcome");
    }
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

describe("repository quickstart contracts", () => {
  it("accepts pick folder input with an optional host and returns a nullable path", () => {
    expect(pickFolderInputSchema.parse({})).toEqual({});
    expect(pickFolderInputSchema.parse({ hostId: "host-1" })).toEqual({ hostId: "host-1" });
    expect(() => pickFolderInputSchema.parse({ hostId: 42 })).toThrow();
    expect(pickFolderResultSchema.parse({ hostId: "host-1", path: "/work/repo" }))
      .toEqual({ hostId: "host-1", path: "/work/repo" });
    expect(pickFolderResultSchema.parse({ hostId: "host-1", path: null }))
      .toEqual({ hostId: "host-1", path: null });
    expect(() => pickFolderResultSchema.parse({ hostId: "host-1" })).toThrow();
  });

  it("accepts probe input and the full probe result shape", () => {
    expect(() => probeRepositoryInputSchema.parse({ hostId: "host-1" })).toThrow();
    expect(probeRepositoryInputSchema.parse({ hostId: "host-1", path: "/work/repo" }))
      .toEqual({ hostId: "host-1", path: "/work/repo" });
    const probe = repositoryProbeSchema.parse({
      hostId: "host-1",
      path: "/work/repo",
      isGitRepo: true,
      hasProtocol: true,
      currentBranch: "main",
      suggestedKey: "repo",
      mainRef: "origin/main",
      checkoutSuggestion: "/work/repo-factory",
      projectMatch: { projectId: "proj-1", label: "Core" },
      factoryBranchState: { exists: true, checkedOutPath: "/work/repo-factory" },
    });
    expect(probe.projectMatch).toEqual({ projectId: "proj-1", label: "Core" });
    // Nulls and absent matches are part of the contract.
    expect(repositoryProbeSchema.parse({
      hostId: "host-1",
      path: "/work/repo",
      isGitRepo: false,
      hasProtocol: false,
      currentBranch: null,
      suggestedKey: "repo",
      mainRef: "origin/main",
      checkoutSuggestion: "/work/repo-factory",
      projectMatch: null,
      factoryBranchState: { exists: false, checkedOutPath: null },
    }).factoryBranchState.exists).toBe(false);
    expect(() => repositoryProbeSchema.parse({
      hostId: "host-1",
      path: "/work/repo",
      isGitRepo: true,
      hasProtocol: false,
      currentBranch: null,
      suggestedKey: "Repo!",
      mainRef: "origin/main",
      checkoutSuggestion: "/work/repo-factory",
      projectMatch: null,
      factoryBranchState: { exists: false, checkedOutPath: null },
    })).toThrow();
  });

  it("accepts resolve-project input and both result shapes", () => {
    expect(() => resolveProjectInputSchema.parse({ hostId: "host-1", path: "/work/repo" })).toThrow();
    expect(resolveProjectInputSchema.parse({ hostId: "host-1", path: "/work/repo", name: "repo" }))
      .toEqual({ hostId: "host-1", path: "/work/repo", name: "repo" });
    expect(resolveProjectResultSchema.parse({ projectId: "proj-1", label: "Core", created: false }))
      .toEqual({ projectId: "proj-1", label: "Core", created: false });
    expect(resolveProjectResultSchema.parse({ projectId: "proj-1", label: null, created: true }))
      .toEqual({ projectId: "proj-1", label: null, created: true });
    expect(() => resolveProjectResultSchema.parse({ projectId: "proj-1", created: true })).toThrow();
  });
});
