import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const isoTimestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest");
const absolutePath = z.string().regex(/^(?:\/|[A-Za-z]:[\\/])/, "must be an absolute path");

export const repositoryKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "must be a lowercase repository key");
export type RepositoryKey = z.infer<typeof repositoryKeySchema>;

/** Optional presentation text. It never participates in repository identity. */
export const repositoryDisplayNameSchema = z.string().trim().min(1).max(64);
export type RepositoryDisplayName = z.infer<typeof repositoryDisplayNameSchema>;

export const providerIdSchema = nonEmptyString.regex(
  /^[a-z0-9][a-z0-9._-]{0,63}$/,
  "must be a lowercase provider id",
);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const providerPreferenceSchema = z.union([z.literal("alternate"), providerIdSchema]);
export type ProviderPreference = z.infer<typeof providerPreferenceSchema>;

export const reasoningLevelSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

export const repositoryRevisionSchema = z
  .object({
    gitCommit: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
    protocolDigest: sha256,
    fileDigests: z.record(z.string(), sha256),
  })
  .strict();
export type RepositoryRevision = z.infer<typeof repositoryRevisionSchema>;

export const repositoryConfigurationSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    repositoryRoot: absolutePath,
    connectedHostId: nonEmptyString,
    checkoutPath: absolutePath,
    factoryBranch: z.literal("factory"),
    mainRef: z.string().min(1).default("origin/main"),
  })
  .strict();
export type RepositoryConfiguration = z.infer<typeof repositoryConfigurationSchema>;

export const repositoryRegistryEntrySchema = z
  .object({
    configuration: repositoryConfigurationSchema,
    projectId: nonEmptyString,
    // Optional: when absent, dispatch spawns against the checkout path and bb
    // registers an unmanaged environment record for it.
    environmentId: nonEmptyString.optional(),
    dispatchPaused: z.boolean().optional(),
    displayName: repositoryDisplayNameSchema.optional(),
  })
  .strict();
export type RepositoryRegistryEntry = z.infer<typeof repositoryRegistryEntrySchema>;

export const repositoryRegistrySchema = z
  .object({
    repositories: z.array(repositoryRegistryEntrySchema),
    defaultRepositoryKey: repositoryKeySchema.nullable(),
  })
  .strict()
  .superRefine((registry, context) => {
    const seen = new Map<string, number>();
    for (const [index, entry] of registry.repositories.entries()) {
      const key = entry.configuration.repositoryKey;
      const previousIndex = seen.get(key);
      if (previousIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "configuration", "repositoryKey"],
          message: `repository key '${key}' duplicates entry ${previousIndex + 1}`,
        });
      } else {
        seen.set(key, index);
      }
    }

    if (registry.repositories.length === 0) {
      if (registry.defaultRepositoryKey !== null) {
        context.addIssue({
          code: "custom",
          path: ["defaultRepositoryKey"],
          message: "an empty repository registry must not select a repository",
        });
      }
    } else if (
      registry.defaultRepositoryKey === null ||
      !seen.has(registry.defaultRepositoryKey)
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultRepositoryKey"],
        message: "defaultRepositoryKey must identify a configured repository",
      });
    }
  });
export type RepositoryRegistry = z.infer<typeof repositoryRegistrySchema>;

export const repositoryRegistryResolutionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("configured"),
      source: z.enum(["registry", "legacy"]),
      repositories: z.array(repositoryRegistryEntrySchema).min(1),
      selectedRepositoryKey: repositoryKeySchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("disabled"),
      source: z.enum(["none", "legacy", "registry"]),
      reason: z.enum(["not-configured", "legacy-incomplete", "explicitly-empty"]),
      repositories: z.array(repositoryRegistryEntrySchema).length(0),
      selectedRepositoryKey: z.null(),
    })
    .strict(),
]);
export type RepositoryRegistryResolution = z.infer<typeof repositoryRegistryResolutionSchema>;

const repositoryRegistrySettingValueSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  },
  repositoryRegistrySchema,
);

export const scheduleSettingsSchema = z
  .object({
    cron: nonEmptyString,
    timeZone: nonEmptyString.default("server-local"),
    nightWindowEndHour: z.number().int().min(0).max(23).default(6),
    minimumStartGapSeconds: z.number().int().min(3600).default(3600),
  })
  .strict();
export type ScheduleSettings = z.infer<typeof scheduleSettingsSchema>;

export const factorySettingsSchema = z
  .object({
    repositoryKey: repositoryKeySchema.optional(),
    repositoryRoot: absolutePath.optional(),
    connectedHostId: nonEmptyString.optional(),
    checkoutPath: absolutePath.optional(),
    projectId: nonEmptyString.optional(),
    environmentId: nonEmptyString.optional(),
    repositoryRegistry: repositoryRegistrySettingValueSchema.optional(),
    scheduleCron: nonEmptyString.optional(),
    timeZone: nonEmptyString.default("server-local"),
    nightWindowEndHour: z.number().int().min(0).max(23).default(6),
    runtimeCapSeconds: z.number().int().positive().default(10_800),
    providerPreference: providerPreferenceSchema.optional(),
    minimumStartGapSeconds: z.number().int().min(3600).default(3600),
    concurrencyLimit: z.number().int().positive().default(1),
    dispatchMode: z.enum(["enabled", "paused"]).default("paused"),
  })
  .strict()
  .superRefine((settings, context) => {
    if (!settings.repositoryRegistry || settings.repositoryRegistry.repositories.length === 0 || settings.repositoryKey === undefined) {
      return;
    }
    if (!settings.repositoryRegistry.repositories.some((entry) => entry.configuration.repositoryKey === settings.repositoryKey)) {
      context.addIssue({
        code: "custom",
        path: ["repositoryKey"],
        message: "repositoryKey must identify a repository in repositoryRegistry",
      });
    }
  });
export type FactorySettings = z.infer<typeof factorySettingsSchema>;

export function resolveRepositoryRegistry(settings: FactorySettings): RepositoryRegistryResolution {
  const parsed = factorySettingsSchema.parse(settings);
  if (parsed.repositoryRegistry) {
    if (parsed.repositoryRegistry.repositories.length === 0) {
      return repositoryRegistryResolutionSchema.parse({
        status: "disabled",
        source: "registry",
        reason: "explicitly-empty",
        repositories: [],
        selectedRepositoryKey: null,
      });
    }
    const selectedRepositoryKey = parsed.repositoryKey ?? parsed.repositoryRegistry.defaultRepositoryKey;
    if (selectedRepositoryKey === null || selectedRepositoryKey === undefined) {
      throw new Error("repositoryRegistry must provide a default repository when configured");
    }
    return repositoryRegistryResolutionSchema.parse({
      status: "configured",
      source: "registry",
      repositories: parsed.repositoryRegistry.repositories,
      selectedRepositoryKey,
    });
  }

  const legacyFields = [
    parsed.repositoryKey,
    parsed.repositoryRoot,
    parsed.connectedHostId,
    parsed.checkoutPath,
    parsed.projectId,
    parsed.environmentId,
  ];
  const hasLegacyConfiguration = legacyFields.some((value) => value !== undefined);
  const legacyConfiguration = {
    repositoryKey: parsed.repositoryKey,
    repositoryRoot: parsed.repositoryRoot,
    connectedHostId: parsed.connectedHostId,
    checkoutPath: parsed.checkoutPath,
    projectId: parsed.projectId,
    environmentId: parsed.environmentId,
  };
  const requiredLegacyFields = [
    legacyConfiguration.repositoryKey,
    legacyConfiguration.repositoryRoot,
    legacyConfiguration.connectedHostId,
    legacyConfiguration.checkoutPath,
    legacyConfiguration.projectId,
  ];
  if (!hasLegacyConfiguration) {
    return repositoryRegistryResolutionSchema.parse({
      status: "disabled",
      source: "none",
      reason: "not-configured",
      repositories: [],
      selectedRepositoryKey: null,
    });
  }
  if (requiredLegacyFields.some((value) => value === undefined)) {
    return repositoryRegistryResolutionSchema.parse({
      status: "disabled",
      source: "legacy",
      reason: "legacy-incomplete",
      repositories: [],
      selectedRepositoryKey: null,
    });
  }

  const migratedEntry = repositoryRegistryEntrySchema.parse({
    configuration: {
      repositoryKey: legacyConfiguration.repositoryKey,
      repositoryRoot: legacyConfiguration.repositoryRoot,
      connectedHostId: legacyConfiguration.connectedHostId,
      checkoutPath: legacyConfiguration.checkoutPath,
      factoryBranch: "factory",
      mainRef: "origin/main",
    },
    projectId: legacyConfiguration.projectId,
    environmentId: legacyConfiguration.environmentId,
  });
  return repositoryRegistryResolutionSchema.parse({
    status: "configured",
    source: "legacy",
    repositories: [migratedEntry],
    selectedRepositoryKey: migratedEntry.configuration.repositoryKey,
  });
}

export const foremanTemplateSourceSchema = z
  .object({
    authority: z.literal("repository-protocol"),
    relativePath: z.literal("plans/factory/foreman.md"),
    contentSha256: sha256,
    repositoryRevision: repositoryRevisionSchema,
  })
  .strict();
export type ForemanTemplateSource = z.infer<typeof foremanTemplateSourceSchema>;

export const queueStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }).strict(),
  z.object({ kind: z.literal("in-progress"), detail: nonEmptyString }).strict(),
  z.object({ kind: z.literal("done"), detail: nonEmptyString.optional() }).strict(),
  z
    .object({ kind: z.literal("blocked-by"), questionId: nonEmptyString, detail: nonEmptyString.optional() })
    .strict(),
  z.object({ kind: z.literal("draft") }).strict(),
  z.object({ kind: z.literal("unknown"), raw: nonEmptyString }).strict(),
]);
export type QueueStatus = z.infer<typeof queueStatusSchema>;

export const queueAuthorizationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("explicit"),
      source: z.literal("queue.approved"),
      text: nonEmptyString,
    })
    .strict(),
  z.object({ kind: z.literal("none"), source: z.literal("none") }).strict(),
]);
export type QueueAuthorization = z.infer<typeof queueAuthorizationSchema>;

export const queueEligibilityReasonSchema = z.enum([
  "not-ready",
  "unmet-dependency",
  "blocking-question",
  "stale-question-gate",
  "missing-authorization",
  "high-risk-approval-missing",
  "repository-policy",
]);
export type QueueEligibilityReason = z.infer<typeof queueEligibilityReasonSchema>;

export const queueEntrySchema = z
  .object({
    id: nonEmptyString,
    title: nonEmptyString,
    status: queueStatusSchema,
    priority: z.number().int().min(1).max(5),
    dependsOn: z.array(nonEmptyString),
    risk: z.enum(["low", "medium", "high"]),
    planPath: nonEmptyString,
    approved: queueAuthorizationSchema,
    acceptance: z.array(nonEmptyString),
    validate: z.array(nonEmptyString),
    notes: z.string().nullable(),
    blockingQuestionIds: z.array(nonEmptyString),
    staleBlockingQuestionIds: z.array(nonEmptyString),
    blockedBy: z.array(nonEmptyString),
    eligible: z.boolean(),
    eligibilityReasons: z.array(queueEligibilityReasonSchema),
  })
  .strict();
export type QueueEntry = z.infer<typeof queueEntrySchema>;

export const questionSchema = z
  .object({
    id: nonEmptyString,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    classification: z.enum(["blocking", "assumption"]),
    dashboardId: nonEmptyString,
    question: nonEmptyString,
    context: nonEmptyString,
    assumed: z.string().nullable(),
    recommended: nonEmptyString.nullable().optional(),
    answer: z.string().nullable(),
  })
  .strict();
export type Question = z.infer<typeof questionSchema>;

export const mergeTaskCommitSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{7,64}$/),
    subject: nonEmptyString,
  })
  .strict();

export const dashboardSummarySchema = z
  .object({
    canonicalPath: z.literal("plans/README.md"),
    factoryBranch: z.literal("factory"),
    mainRef: nonEmptyString,
    factoryAhead: z.number().int().nonnegative(),
    mainBehind: z.number().int().nonnegative(),
    taskCommits: z.array(mergeTaskCommitSchema),
    safeFastForward: z.boolean(),
    canonicalDashboardUrl: z.string().url().nullable(),
  })
  .strict();
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export const foremanOutcomeSchema = z.enum(["success", "blocked", "failed-safe", "no-op"]);
export type ForemanOutcome = z.infer<typeof foremanOutcomeSchema>;

export const currentRunSummarySchema = z
  .object({
    state: foremanOutcomeSchema,
    lastRunAt: isoTimestamp.nullable(),
    currentPath: z.literal("plans/factory/current.md"),
    latestRunPath: z.string().nullable(),
  })
  .strict();
export type CurrentRunSummary = z.infer<typeof currentRunSummarySchema>;

export const protocolSnapshotSchema = z
  .object({
    repository: repositoryConfigurationSchema,
    revision: repositoryRevisionSchema,
    capturedAt: isoTimestamp,
    foremanTemplate: foremanTemplateSourceSchema,
    queue: z.array(queueEntrySchema),
    questions: z.array(questionSchema),
    dashboard: dashboardSummarySchema,
    currentRun: currentRunSummarySchema,
  })
  .strict();
export type ProtocolSnapshot = z.infer<typeof protocolSnapshotSchema>;

export const idempotencyKeySchema = z
  .string()
  .regex(
    /^bbf:v1:[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be bbf:v1:<repository>:<operation>:<UUID>",
  );
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

export const runIntentSchema = z
  .object({
    runId: nonEmptyString,
    repositoryKey: repositoryKeySchema,
    trigger: z.enum(["schedule", "manual", "recovery"]),
    idempotencyKey: idempotencyKeySchema,
    requestedAt: isoTimestamp,
    baseRevision: repositoryRevisionSchema,
    queueItemIds: z.array(nonEmptyString),
    authorizationProvenance: z
      .array(
        z
          .object({
            queueItemId: nonEmptyString,
            source: z.enum(["queue.approved", "none"]),
            approvedText: z.string().nullable(),
          })
          .strict(),
      )
      .refine(
        (items) => items.every((item) => item.source === "queue.approved" ? item.approvedText !== null : item.approvedText === null),
        "authorization provenance must match the recorded approval text",
      ),
  })
  .strict();
export type RunIntent = z.infer<typeof runIntentSchema>;

export const dispatchAttemptSchema = z
  .object({
    attemptId: nonEmptyString,
    runId: nonEmptyString,
    repositoryKey: repositoryKeySchema,
    providerId: providerIdSchema,
    model: nonEmptyString,
    reasoningLevel: reasoningLevelSchema,
    workerThreadId: z.string().nullable(),
    status: z.enum(["pending", "started", "completed", "failed-safe", "blocked", "no-op", "cancel-requested", "reconciliation-required"]),
    startedAt: isoTimestamp.nullable(),
    finishedAt: isoTimestamp.nullable(),
  })
  .strict();
export type DispatchAttempt = z.infer<typeof dispatchAttemptSchema>;

export const ownershipLeaseSchema = z
  .object({
    leaseId: nonEmptyString,
    repositoryKey: repositoryKeySchema,
    runId: nonEmptyString,
    queueItemIds: z.array(nonEmptyString),
    workerThreadId: z.string().nullable(),
    authorizationProvenance: z.array(nonEmptyString),
    acquiredAt: isoTimestamp,
    expiresAt: isoTimestamp,
    status: z.enum(["held", "release-requested", "released", "reconciliation-required"]),
  })
  .strict();
export type OwnershipLease = z.infer<typeof ownershipLeaseSchema>;

export const providerStatusSchema = z
  .object({
    providerId: providerIdSchema,
    model: nonEmptyString,
    reasoningLevel: reasoningLevelSchema,
    availability: z.enum(["available", "limited", "unavailable", "unknown"]),
    limitedUntil: isoTimestamp.nullable(),
    activeThreadCount: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    permissionModes: z.array(nonEmptyString).optional(),
  })
  .strict();
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const hostPreflightSchema = z
  .object({
    hostId: nonEmptyString,
    status: z.enum(["online", "offline", "unknown"]),
    checkoutExists: z.boolean(),
    branch: z.string().nullable(),
    requiredTools: z.record(z.string(), z.boolean()),
    browserAvailable: z.boolean().nullable(),
    dbtStudioAvailable: z.boolean().nullable(),
    ok: z.boolean(),
    reasons: z.array(nonEmptyString),
  })
  .strict();
export type HostPreflight = z.infer<typeof hostPreflightSchema>;

export const factoryErrorCategorySchema = z.enum([
  "invalid-input",
  "not-found",
  "conflict",
  "stale-revision",
  "authorization-required",
  "dependency-unsatisfied",
  "blocked-by-question",
  "host-unavailable",
  "checkout-invalid",
  "provider-unavailable",
  "paused",
  "idempotency-conflict",
  "unsupported",
  "internal",
]);
export type FactoryErrorCategory = z.infer<typeof factoryErrorCategorySchema>;

const staleRevisionErrorSchema = z
  .object({
    category: z.literal("stale-revision"),
    message: nonEmptyString,
    fieldErrors: z.record(z.string(), z.array(nonEmptyString)).optional(),
    expectedRevision: repositoryRevisionSchema,
    actualRevision: repositoryRevisionSchema,
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();

const nonStaleFactoryErrorSchema = z
  .object({
    category: z.enum([
      "invalid-input",
      "not-found",
      "conflict",
      "authorization-required",
      "dependency-unsatisfied",
      "blocked-by-question",
      "host-unavailable",
      "checkout-invalid",
      "provider-unavailable",
      "paused",
      "idempotency-conflict",
      "unsupported",
      "internal",
    ]),
    message: nonEmptyString,
    fieldErrors: z.record(z.string(), z.array(nonEmptyString)).optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();

export const factoryErrorSchema = z.union([staleRevisionErrorSchema, nonStaleFactoryErrorSchema]);
export const staleRevisionErrorVariantSchema = staleRevisionErrorSchema;
export type FactoryError = z.infer<typeof factoryErrorSchema>;

export const actionKindSchema = z.enum([
  "preview",
  "run-now",
  "pause",
  "resume",
  "answer-question",
  "approve-queue",
  "recommend-question",
  "recommend-approval",
  "retry",
  "stop",
  "integration-report",
  "scaffold-protocol",
  "provision-checkout",
]);
export type ActionKind = z.infer<typeof actionKindSchema>;

export const revisionFreeActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preview") }).strict(),
  z.object({ kind: z.literal("integration-report") }).strict(),
]);
export type RevisionFreeAction = z.infer<typeof revisionFreeActionSchema>;

const repositoryQuestionAnswerActionSchema = z
  .object({
    kind: z.literal("answer-question"),
    source: z.literal("repository-question"),
    questionId: nonEmptyString,
    answer: nonEmptyString,
  })
  .strict();

export const approvalDecisionSchema = z.enum(["allow_once", "allow_for_session", "deny"]);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const pendingInteractionQuestionOptionSchema = z
  .object({
    description: z.string().optional(),
    label: z.string(),
    value: z.string(),
  })
  .strict();
export type PendingInteractionQuestionOption = z.infer<typeof pendingInteractionQuestionOptionSchema>;

export const pendingInteractionQuestionSchema = z
  .object({
    allowFreeText: z.boolean(),
    id: z.string(),
    multiSelect: z.boolean(),
    options: z.array(pendingInteractionQuestionOptionSchema).optional(),
    prompt: z.string(),
    shortLabel: z.string().optional(),
  })
  .strict();
export type PendingInteractionQuestion = z.infer<typeof pendingInteractionQuestionSchema>;

const pendingApprovalMetadataSchema = z
  .object({
    availableDecisions: z.array(approvalDecisionSchema),
    kind: z.literal("approval"),
  })
  .strict();

const pendingUserQuestionMetadataSchema = z
  .object({
    kind: z.literal("user_question"),
    questions: z.array(pendingInteractionQuestionSchema),
  })
  .strict();

const pendingPluginMetadataSchema = z.object({ kind: z.literal("plugin") }).strict();

export const pendingInteractionMetadataSchema = z.discriminatedUnion("kind", [
  pendingApprovalMetadataSchema,
  pendingUserQuestionMetadataSchema,
  pendingPluginMetadataSchema,
]);
export type PendingInteractionMetadata = z.infer<typeof pendingInteractionMetadataSchema>;

const userAnswerResolutionSchema = z
  .object({
    answers: z.record(
      z.string(),
      z
        .object({
          freeText: z.string().optional(),
          selected: z.array(z.string()),
        })
        .strict(),
    ),
    kind: z.literal("user_answer"),
  })
  .strict();

const approvalResolutionSchema = z
  .object({
    decision: approvalDecisionSchema,
    kind: z.literal("approval"),
  })
  .strict();

export const bbInteractionResolutionSchema = z.discriminatedUnion("kind", [
  userAnswerResolutionSchema,
  approvalResolutionSchema,
]);
export type BbInteractionResolution = z.infer<typeof bbInteractionResolutionSchema>;

const bbInteractionAnswerActionSchema = z
  .object({
    kind: z.literal("answer-question"),
    source: z.literal("bb-interaction"),
    interactionId: nonEmptyString,
    resolution: bbInteractionResolutionSchema,
  })
  .strict();
const approveQueueActionSchema = z
  .object({ kind: z.literal("approve-queue"), queueItemId: nonEmptyString, approvedText: nonEmptyString })
  .strict();

export const repositoryActionSchema = z.union([
  repositoryQuestionAnswerActionSchema,
  approveQueueActionSchema,
]);
export type RepositoryAction = z.infer<typeof repositoryActionSchema>;

/**
 * Advisory only: spawns a BB thread that recommends an answer for a repository
 * question. Writes nothing to the repository; the operator still records the
 * answer through answer-question.
 */
const recommendQuestionActionSchema = z
  .object({
    kind: z.literal("recommend-question"),
    questionId: nonEmptyString,
    providerId: providerIdSchema,
    model: nonEmptyString,
    reasoningLevel: reasoningLevelSchema,
    serviceTier: z.enum(["default", "fast"]).optional(),
  })
  .strict();

/**
 * Advisory only: spawns a BB thread that recommends an approved line for a
 * queue item. Writes nothing to the repository; the operator still records
 * the approval through approve-queue.
 */
const recommendApprovalActionSchema = z
  .object({
    kind: z.literal("recommend-approval"),
    queueItemId: nonEmptyString,
    providerId: providerIdSchema,
    model: nonEmptyString,
    reasoningLevel: reasoningLevelSchema,
    serviceTier: z.enum(["default", "fast"]).optional(),
  })
  .strict();

/**
 * A manual run may pin provider, model, and reasoning level; the three are
 * all-or-none so a partial override never silently mixes with rotation.
 * serviceTier stays independently optional, matching the recommend-* actions.
 */
const runNowActionSchema = z
  .object({
    kind: z.literal("run-now"),
    providerId: providerIdSchema.optional(),
    model: nonEmptyString.optional(),
    reasoningLevel: reasoningLevelSchema.optional(),
    serviceTier: z.enum(["default", "fast"]).optional(),
  })
  .strict()
  .superRefine((action, context) => {
    const triple = [action.providerId, action.model, action.reasoningLevel];
    if (triple.some((value) => value !== undefined) && triple.some((value) => value === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["providerId"],
        message: "providerId, model, and reasoningLevel must be provided together",
      });
    }
  });

export const bbInteractionActionSchema = z.union([
  runNowActionSchema,
  z.object({ kind: z.literal("pause") }).strict(),
  z.object({ kind: z.literal("resume") }).strict(),
  bbInteractionAnswerActionSchema,
  recommendQuestionActionSchema,
  recommendApprovalActionSchema,
  z.object({ kind: z.literal("retry"), attemptId: nonEmptyString }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
]);
export type BbInteractionAction = z.infer<typeof bbInteractionActionSchema>;

/**
 * Writes the bundled factory protocol files into a managed checkout, creating
 * only missing files. The per-file create-only compare-and-swap is the guard;
 * expectedRevision binds the durable intent and stays optional because a
 * checkout without protocol files has no snapshot revision to pass.
 */
const scaffoldProtocolActionSchema = z
  .object({ kind: z.literal("scaffold-protocol") })
  .strict();
export type ScaffoldProtocolAction = z.infer<typeof scaffoldProtocolActionSchema>;

/**
 * Provisions the checkout a repository registers. "worktree" mode runs
 * `git worktree add <repositoryRoot>-factory` on the connected host, creating
 * the `factory` branch when missing; "direct" mode only verifies the root is
 * a Git checkout and reports its branch (switching is never this action's
 * job). hostId + repositoryRoot make the target explicit so the add wizard
 * can provision before a registry entry exists; when both are omitted the
 * configured entry for repositoryKey supplies them.
 */
const provisionCheckoutActionSchema = z
  .object({
    kind: z.literal("provision-checkout"),
    mode: z.enum(["worktree", "direct"]),
    hostId: nonEmptyString.optional(),
    repositoryRoot: absolutePath.optional(),
  })
  .strict()
  .superRefine((action, context) => {
    if ((action.hostId === undefined) !== (action.repositoryRoot === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["repositoryRoot"],
        message: "hostId and repositoryRoot must be provided together",
      });
    }
  });
export type ProvisionCheckoutAction = z.infer<typeof provisionCheckoutActionSchema>;

export const guardedActionSchema = z.union([repositoryActionSchema, bbInteractionActionSchema]);
export type GuardedAction = z.infer<typeof guardedActionSchema>;

export const factoryActionSchema = z.union([
  revisionFreeActionSchema,
  guardedActionSchema,
  scaffoldProtocolActionSchema,
  provisionCheckoutActionSchema,
]);
export type FactoryAction = z.infer<typeof factoryActionSchema>;

function validateIdempotencyBinding(
  value: { repositoryKey: string; action: { kind: string }; idempotencyKey: string },
  ctx: z.RefinementCtx,
): void {
  const [, , keyRepository, keyAction] = value.idempotencyKey.split(":");
  if (keyRepository !== value.repositoryKey) {
    ctx.addIssue({ code: "custom", path: ["idempotencyKey"], message: "repository segment must match repositoryKey" });
  }
  if (keyAction !== value.action.kind) {
    ctx.addIssue({ code: "custom", path: ["idempotencyKey"], message: "action segment must match action.kind" });
  }
}

export const revisionFreeActionRequestSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    action: revisionFreeActionSchema,
    idempotencyKey: idempotencyKeySchema,
    expectedRevision: z.undefined().optional(),
  })
  .strict()
  .superRefine(validateIdempotencyBinding);
export type RevisionFreeActionRequest = z.infer<typeof revisionFreeActionRequestSchema>;

export const guardedActionRequestSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    action: guardedActionSchema,
    idempotencyKey: idempotencyKeySchema,
    expectedRevision: repositoryRevisionSchema,
  })
  .strict()
  .superRefine(validateIdempotencyBinding);
export type GuardedActionRequest = z.infer<typeof guardedActionRequestSchema>;

export const repositoryActionRequestSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    action: repositoryActionSchema,
    idempotencyKey: idempotencyKeySchema,
    expectedRevision: repositoryRevisionSchema,
  })
  .strict()
  .superRefine(validateIdempotencyBinding);
export type RepositoryActionRequest = z.infer<typeof repositoryActionRequestSchema>;

export const bbInteractionActionRequestSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    action: bbInteractionActionSchema,
    idempotencyKey: idempotencyKeySchema,
    // Optional so dispatch controls keep working when the repository protocol
    // files fail to parse (the stale-revision guard is skipped when absent).
    expectedRevision: repositoryRevisionSchema.optional(),
  })
  .strict()
  .superRefine(validateIdempotencyBinding);
export type BbInteractionActionRequest = z.infer<typeof bbInteractionActionRequestSchema>;

/** The pre-protocol revision a scaffold caller sends when no snapshot exists. */
export const EMPTY_REPOSITORY_REVISION: RepositoryRevision = {
  gitCommit: null,
  protocolDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  fileDigests: {},
};

export const scaffoldProtocolActionRequestSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    action: scaffoldProtocolActionSchema,
    idempotencyKey: idempotencyKeySchema,
    expectedRevision: repositoryRevisionSchema.default(EMPTY_REPOSITORY_REVISION),
  })
  .strict()
  .superRefine(validateIdempotencyBinding);
export type ScaffoldProtocolActionRequest = z.infer<typeof scaffoldProtocolActionRequestSchema>;

/**
 * Provision requests carry the same envelope as scaffold: repositoryKey binds
 * the idempotency key even when the action targets an explicit host + root
 * for a repository that is not registered yet.
 */
export const provisionCheckoutActionRequestSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    action: provisionCheckoutActionSchema,
    idempotencyKey: idempotencyKeySchema,
    expectedRevision: repositoryRevisionSchema.default(EMPTY_REPOSITORY_REVISION),
  })
  .strict()
  .superRefine(validateIdempotencyBinding);
export type ProvisionCheckoutActionRequest = z.infer<typeof provisionCheckoutActionRequestSchema>;

export const factoryActionRequestSchema = z.union([
  revisionFreeActionRequestSchema,
  repositoryActionRequestSchema,
  bbInteractionActionRequestSchema,
  scaffoldProtocolActionRequestSchema,
  provisionCheckoutActionRequestSchema,
]);
export type FactoryActionRequest = z.infer<typeof factoryActionRequestSchema>;

const actionOutcomeFields = {
  status: z.enum(["preview", "accepted", "already-applied"]),
  message: nonEmptyString,
  revision: repositoryRevisionSchema.nullable(),
  runId: z.string().nullable(),
  leaseId: z.string().nullable(),
  queueItemId: z.string().nullable(),
};

export const answerQuestionOutcomeSchema = z.discriminatedUnion("source", [
  z
    .object({
      ...actionOutcomeFields,
      action: z.literal("answer-question"),
      source: z.literal("bb-interaction"),
      interactionId: nonEmptyString,
      questionId: z.null().optional(),
    })
    .strict(),
  z
    .object({
      ...actionOutcomeFields,
      action: z.literal("answer-question"),
      source: z.literal("repository-question"),
      questionId: nonEmptyString,
      interactionId: z.null().optional(),
    })
    .strict(),
]);
export type AnswerQuestionOutcome = z.infer<typeof answerQuestionOutcomeSchema>;

const nonAnswerActionKindSchema = z.enum([
  "preview",
  "run-now",
  "pause",
  "resume",
  "approve-queue",
  "retry",
  "stop",
  "integration-report",
]);

export const nonAnswerActionOutcomeSchema = z
  .object({
    ...actionOutcomeFields,
    action: nonAnswerActionKindSchema,
    questionId: z.null().optional(),
    interactionId: z.null().optional(),
  })
  .strict();
export type NonAnswerActionOutcome = z.infer<typeof nonAnswerActionOutcomeSchema>;

/** Accepted recommendation spawns carry the thread the UI should open. */
export const recommendQuestionOutcomeSchema = z
  .object({
    ...actionOutcomeFields,
    action: z.literal("recommend-question"),
    questionId: nonEmptyString,
    interactionId: z.null().optional(),
    threadId: nonEmptyString,
  })
  .strict();
export type RecommendQuestionOutcome = z.infer<typeof recommendQuestionOutcomeSchema>;

/** Accepted approval recommendations carry the thread the UI should open. */
export const recommendApprovalOutcomeSchema = z
  .object({
    ...actionOutcomeFields,
    action: z.literal("recommend-approval"),
    queueItemId: nonEmptyString,
    interactionId: z.null().optional(),
    threadId: nonEmptyString,
  })
  .strict();
export type RecommendApprovalOutcome = z.infer<typeof recommendApprovalOutcomeSchema>;

/** Scaffold results list each target's disposition and the commit that landed. */
export const scaffoldProtocolOutcomeSchema = z
  .object({
    ...actionOutcomeFields,
    action: z.literal("scaffold-protocol"),
    questionId: z.null().optional(),
    interactionId: z.null().optional(),
    written: z.array(nonEmptyString),
    skipped: z.array(nonEmptyString),
    commitSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
  })
  .strict();
export type ScaffoldProtocolOutcome = z.infer<typeof scaffoldProtocolOutcomeSchema>;

/**
 * Provision results describe the checkout the caller should register.
 * `status` stays "accepted" only when the host changed (a worktree add
 * landed); non-mutating results keep "preview" or "already-applied" so the
 * router does not publish a repository-changed invalidation for a read-only
 * outcome.
 */
export const provisionCheckoutOutcomeSchema = z
  .object({
    ...actionOutcomeFields,
    action: z.literal("provision-checkout"),
    questionId: z.null().optional(),
    interactionId: z.null().optional(),
    mode: z.enum(["worktree", "direct"]),
    /**
     * "provisioned": the worktree was created on the factory branch.
     * "already-provisioned": the worktree already existed on factory.
     * "branch-in-use": the factory branch is checked out in another worktree
     * (blockingWorktreePath); the wizard offers the direct-checkout fallback.
     * "verified": direct mode found the root on the factory branch.
     * "off-branch": direct mode found a different branch; surfacing the
     * switch is the caller's job, never this action's.
     */
    outcome: z.enum(["provisioned", "already-provisioned", "branch-in-use", "verified", "off-branch"]),
    /** Path to register as checkoutPath: `<root>-factory` or the root itself. */
    checkoutPath: absolutePath,
    /** Branch checked out at checkoutPath after the action, when known. */
    branch: nonEmptyString.nullable(),
    /** The worktree already holding the factory branch (branch-in-use only). */
    blockingWorktreePath: absolutePath.nullable(),
    /** Whether this run created the factory branch; null when no add ran. */
    branchCreated: z.boolean().nullable(),
    /** Whether the factory branch existed before the add; null when unprobed. */
    branchExisted: z.boolean().nullable(),
    /** Remote base ref a created branch started from; null for plain HEAD or no creation. */
    baseRef: nonEmptyString.nullable(),
  })
  .strict();
export type ProvisionCheckoutOutcome = z.infer<typeof provisionCheckoutOutcomeSchema>;

export const actionOutcomeSchema = z.union([
  answerQuestionOutcomeSchema,
  recommendQuestionOutcomeSchema,
  recommendApprovalOutcomeSchema,
  scaffoldProtocolOutcomeSchema,
  provisionCheckoutOutcomeSchema,
  nonAnswerActionOutcomeSchema,
]);
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;

export interface ActionResult<T> {
  readonly ok: true;
  readonly result: T;
  readonly revision: RepositoryRevision | null;
}

export interface FailedActionResult {
  readonly ok: false;
  readonly error: FactoryError;
}

export type FactoryActionResult = ActionResult<ActionOutcome> | FailedActionResult;

export const factoryActionResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: actionOutcomeSchema, revision: repositoryRevisionSchema.nullable() }).strict(),
  z.object({ ok: z.literal(false), error: factoryErrorSchema }).strict(),
]);

export const invalidationEventSchema = z
  .object({
    channel: z.literal("factory"),
    kind: z.enum(["repository.changed", "run.changed", "lease.changed", "settings.changed", "host.changed"]),
    repositoryKey: repositoryKeySchema.nullable(),
    revision: repositoryRevisionSchema.nullable(),
    reason: nonEmptyString,
    durableReloadRequired: z.literal(true),
  })
  .strict();
export type InvalidationEvent = z.infer<typeof invalidationEventSchema>;

export const repositorySelectionInputSchema = z
  .object({
    selectedRepositoryKey: repositoryKeySchema.nullable().optional(),
  })
  .strict();
export type RepositorySelectionInput = z.infer<typeof repositorySelectionInputSchema>;

export const repositorySelectionSchema = z
  .object({
    configuration: repositoryConfigurationSchema,
    projectId: nonEmptyString,
    environmentId: nonEmptyString.nullable(),
    dispatchPaused: z.boolean(),
    displayName: repositoryDisplayNameSchema.optional(),
    selected: z.boolean(),
    available: z.boolean(),
    reasons: z.array(nonEmptyString),
  })
  .strict();
export type RepositorySelection = z.infer<typeof repositorySelectionSchema>;

export const repositorySelectionProjectionSchema = z
  .object({
    repositories: z.array(repositorySelectionSchema),
    selectedRepositoryKey: repositoryKeySchema.nullable(),
  })
  .strict();
export type RepositorySelectionProjection = z.infer<typeof repositorySelectionProjectionSchema>;

export const repositoryReadInputSchema = z
  .object({ repositoryKey: repositoryKeySchema })
  .strict();
export type RepositoryReadInput = z.infer<typeof repositoryReadInputSchema>;

export const settingsValidationSchema = z
  .object({
    valid: z.boolean(),
    fieldErrors: z.record(z.string(), z.array(nonEmptyString)),
  })
  .strict();
export type SettingsValidation = z.infer<typeof settingsValidationSchema>;

export const dispatchStatusSchema = z
  .object({
    mode: z.enum(["enabled", "paused"]),
    repositoryPaused: z.boolean(),
    acceptingNewRuns: z.boolean(),
    activeRunCount: z.number().int().nonnegative(),
    reason: nonEmptyString.nullable(),
  })
  .strict();
export type DispatchStatus = z.infer<typeof dispatchStatusSchema>;

export const settingsProjectionSchema = z
  .object({
    settings: factorySettingsSchema,
    validation: settingsValidationSchema,
    dispatch: dispatchStatusSchema,
  })
  .strict();
export type SettingsProjection = z.infer<typeof settingsProjectionSchema>;

export const healthProjectionSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    providers: z.array(providerStatusSchema),
    host: hostPreflightSchema,
  })
  .strict();
export type HealthProjection = z.infer<typeof healthProjectionSchema>;

const pendingInteractionFields = {
  source: z.literal("bb-interaction"),
  interactionId: nonEmptyString,
  threadId: nonEmptyString,
  turnId: nonEmptyString.nullable(),
  status: z.literal("pending"),
  title: nonEmptyString,
  prompt: nonEmptyString.nullable(),
  createdAt: isoTimestamp,
  expiresAt: isoTimestamp.nullable(),
};

export const pendingInteractionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...pendingInteractionFields,
      kind: z.literal("approval"),
      metadata: pendingApprovalMetadataSchema,
    })
    .strict(),
  z
    .object({
      ...pendingInteractionFields,
      kind: z.literal("user-question"),
      metadata: pendingUserQuestionMetadataSchema,
    })
    .strict(),
  z
    .object({
      ...pendingInteractionFields,
      kind: z.literal("plugin"),
      metadata: pendingPluginMetadataSchema,
    })
    .strict(),
]);
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

export const pendingInteractionsProjectionSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    interactions: z.array(pendingInteractionSchema),
  })
  .strict();
export type PendingInteractionsProjection = z.infer<typeof pendingInteractionsProjectionSchema>;

export const operationalRunListInputSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    cursor: nonEmptyString.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type OperationalRunListInput = z.infer<typeof operationalRunListInputSchema>;

export const operationalRunDetailInputSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    runId: nonEmptyString,
  })
  .strict();
export type OperationalRunDetailInput = z.infer<typeof operationalRunDetailInputSchema>;

export const canonicalFileRecordLinkSchema = z
  .object({
    relativePath: nonEmptyString,
    recordType: z.enum([
      "queue-entry",
      "question",
      "dashboard",
      "current-run",
      "immutable-run",
      "foreman-template",
    ]),
    recordId: nonEmptyString,
    repositoryRevision: repositoryRevisionSchema,
  })
  .strict();
export type CanonicalFileRecordLink = z.infer<typeof canonicalFileRecordLinkSchema>;

export const operationalRunStatusSchema = z.enum([
  "pending",
  "started",
  "completed",
  "failed-safe",
  "blocked",
  "no-op",
  "cancel-requested",
  "reconciliation-required",
]);
export type OperationalRunStatus = z.infer<typeof operationalRunStatusSchema>;

const operationalRunSummaryFields = {
  runId: nonEmptyString,
  repositoryKey: repositoryKeySchema,
  requestedAt: isoTimestamp,
  startedAt: isoTimestamp.nullable(),
  finishedAt: isoTimestamp.nullable(),
  providerId: providerIdSchema.nullable(),
  workerThreadId: z.string().nullable(),
  projectId: nonEmptyString.nullable(),
  environmentId: nonEmptyString.nullable(),
  queueItemIds: z.array(nonEmptyString),
  repositoryRevision: repositoryRevisionSchema,
  canonicalRecords: z.array(canonicalFileRecordLinkSchema),
};

const preDispatchOperationalRunSummarySchema = z
  .object({
    ...operationalRunSummaryFields,
    status: z.literal("pending"),
  })
  .strict();

const dispatchedOperationalRunSummarySchema = z
  .object({
    ...operationalRunSummaryFields,
    status: z.enum([
      "started",
      "completed",
      "failed-safe",
      "blocked",
      "no-op",
      "cancel-requested",
      "reconciliation-required",
    ]),
    projectId: nonEmptyString,
    // Nullable: an unmanaged spawn that fails ambiguously never yields an
    // environment id, so a reconciliation-required run can honestly lack one.
    environmentId: nonEmptyString.nullable(),
  })
  .strict();

export const operationalRunSummarySchema = z.union([
  preDispatchOperationalRunSummarySchema,
  dispatchedOperationalRunSummarySchema,
]);
export type OperationalRunSummary = z.infer<typeof operationalRunSummarySchema>;

export const operationalRunListProjectionSchema = z
  .object({
    runs: z.array(operationalRunSummarySchema),
    nextCursor: nonEmptyString.nullable(),
  })
  .strict();
export type OperationalRunListProjection = z.infer<typeof operationalRunListProjectionSchema>;

export const operationalRunDetailSchema = z
  .object({
    summary: operationalRunSummarySchema,
    intent: runIntentSchema,
    attempts: z.array(dispatchAttemptSchema),
    lease: ownershipLeaseSchema.nullable(),
  })
  .strict();
export type OperationalRunDetail = z.infer<typeof operationalRunDetailSchema>;

export const operationalRunDetailProjectionSchema = z
  .object({ run: operationalRunDetailSchema.nullable() })
  .strict();
export type OperationalRunDetailProjection = z.infer<typeof operationalRunDetailProjectionSchema>;

/**
 * Writable global dispatch settings. `null` unsets an optional value; absent
 * keys are left unchanged. Applied through the plugin settings handle.
 */
export const factorySettingsPatchSchema = z
  .object({
    dispatchMode: z.enum(["enabled", "paused"]).optional(),
    scheduleCron: nonEmptyString.nullable().optional(),
    timeZone: nonEmptyString.optional(),
    nightWindowEndHour: z.number().int().min(0).max(23).optional(),
    runtimeCapSeconds: z.number().int().positive().optional(),
    providerPreference: providerPreferenceSchema.nullable().optional(),
    minimumStartGapSeconds: z.number().int().min(3600).optional(),
    concurrencyLimit: z.number().int().positive().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "at least one settings field is required");
export type FactorySettingsPatch = z.infer<typeof factorySettingsPatchSchema>;

export const settingsMutationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), message: nonEmptyString }).strict(),
  z.object({ ok: z.literal(false), error: factoryErrorSchema }).strict(),
]);
export type SettingsMutationResult = z.infer<typeof settingsMutationResultSchema>;

export const updateSettingsInputSchema = z
  .object({ repositoryKey: repositoryKeySchema, patch: factorySettingsPatchSchema })
  .strict();
export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>;

export const updateRepositoryInputSchema = z
  .object({
    repositoryKey: repositoryKeySchema,
    dispatchPaused: z.boolean().optional(),
    displayName: repositoryDisplayNameSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (input) => input.dispatchPaused !== undefined || input.displayName !== undefined,
    "at least one repository setting is required",
  );
export type UpdateRepositoryInput = z.infer<typeof updateRepositoryInputSchema>;

export const addRepositoryInputSchema = z
  .object({
    configuration: z
      .object({
        repositoryKey: repositoryKeySchema,
        repositoryRoot: absolutePath,
        connectedHostId: nonEmptyString,
        checkoutPath: absolutePath,
        mainRef: nonEmptyString.default("origin/main"),
      })
      .strict(),
    projectId: nonEmptyString,
    environmentId: nonEmptyString.optional(),
    dispatchPaused: z.boolean().default(true),
    displayName: repositoryDisplayNameSchema.optional(),
  })
  .strict();
export type AddRepositoryInput = z.infer<typeof addRepositoryInputSchema>;

export const registryOptionHostSchema = z
  .object({ hostId: nonEmptyString, label: nonEmptyString.nullable(), status: nonEmptyString })
  .strict();
export type RegistryOptionHost = z.infer<typeof registryOptionHostSchema>;

export const registryOptionProjectSchema = z
  .object({ projectId: nonEmptyString, label: nonEmptyString.nullable() })
  .strict();
export type RegistryOptionProject = z.infer<typeof registryOptionProjectSchema>;

export const registryOptionsProjectionSchema = z
  .object({
    hosts: z.array(registryOptionHostSchema),
    projects: z.array(registryOptionProjectSchema),
  })
  .strict();
export type RegistryOptionsProjection = z.infer<typeof registryOptionsProjectionSchema>;

/**
 * Add-repository quickstart reads. The wizard never asks for environment,
 * host, or project ids: the folder picker runs on a resolved host, the probe
 * derives every registration field, and project resolution matches a source
 * or creates the project server-side.
 */
export const pickFolderInputSchema = z
  .object({
    /** Host that shows the picker; absent means the sole connected host. */
    hostId: nonEmptyString.optional(),
  })
  .strict();
export type PickFolderInput = z.infer<typeof pickFolderInputSchema>;

export const pickFolderResultSchema = z
  .object({
    /** The host the picker ran on after resolution. */
    hostId: nonEmptyString,
    /** The picked folder; null when the user canceled. */
    path: absolutePath.nullable(),
  })
  .strict();
export type PickFolderResult = z.infer<typeof pickFolderResultSchema>;

export const probeRepositoryInputSchema = z
  .object({
    hostId: nonEmptyString,
    path: absolutePath,
  })
  .strict();
export type ProbeRepositoryInput = z.infer<typeof probeRepositoryInputSchema>;

export const projectSourceMatchSchema = z
  .object({
    projectId: nonEmptyString,
    label: nonEmptyString.nullable(),
  })
  .strict();
export type ProjectSourceMatch = z.infer<typeof projectSourceMatchSchema>;

/** Where the factory branch is checked out, from `git worktree list`. */
export const factoryBranchStateSchema = z
  .object({
    exists: z.boolean(),
    checkedOutPath: absolutePath.nullable(),
  })
  .strict();
export type FactoryBranchState = z.infer<typeof factoryBranchStateSchema>;

export const repositoryProbeSchema = z
  .object({
    hostId: nonEmptyString,
    path: absolutePath,
    isGitRepo: z.boolean(),
    /** True when plans/factory/foreman.md already exists inside the path. */
    hasProtocol: z.boolean(),
    /** The branch the picked checkout is on; null when unreadable or detached. */
    currentBranch: nonEmptyString.nullable(),
    suggestedKey: repositoryKeySchema,
    mainRef: nonEmptyString,
    /** The dedicated worktree target: `<path>-factory`. */
    checkoutSuggestion: absolutePath,
    projectMatch: projectSourceMatchSchema.nullable(),
    factoryBranchState: factoryBranchStateSchema,
  })
  .strict();
export type RepositoryProbe = z.infer<typeof repositoryProbeSchema>;

/**
 * Resolves the BB project for a picked folder: a source local_path match wins,
 * otherwise the handler creates the project (name + local_path source). This
 * is the only wizard call that mutates BB state, so it sits on the action
 * router rather than the read-only route set.
 */
export const resolveProjectInputSchema = z
  .object({
    hostId: nonEmptyString,
    path: absolutePath,
    name: nonEmptyString,
  })
  .strict();
export type ResolveProjectInput = z.infer<typeof resolveProjectInputSchema>;

export const resolveProjectResultSchema = z
  .object({
    projectId: nonEmptyString,
    label: nonEmptyString.nullable(),
    created: z.boolean(),
  })
  .strict();
export type ResolveProjectResult = z.infer<typeof resolveProjectResultSchema>;
