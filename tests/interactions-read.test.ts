import { describe, expect, it, vi } from "vitest";
import { pendingInteractionsProjectionSchema } from "../src/contracts.js";
import {
  createPendingInteractionReader,
  type PendingInteractionSdk,
  type PendingInteractionRepositoryScope,
} from "../src/interactions/read.js";

type SdkThreads = PendingInteractionSdk["threads"];
type SdkThread = Awaited<ReturnType<SdkThreads["list"]>>[number];
type SdkInteraction = Awaited<ReturnType<SdkThreads["interactions"]["list"]>>[number];
type SdkProviderInteraction = Extract<SdkInteraction, { providerId: string }>;
type SdkThreadListArgs = Parameters<SdkThreads["list"]>[0];
type SdkInteractionListArgs = Parameters<SdkThreads["interactions"]["list"]>[0];

const scope: PendingInteractionRepositoryScope = {
  repositoryKey: "monorepo",
  projectId: "project-1",
  environmentId: "environment-1",
};

function makeThread(
  overrides: Pick<SdkThread, "id" | "projectId" | "environmentId" | "hasPendingInteraction"> & Partial<SdkThread>,
): SdkThread {
  const defaultThread: SdkThread = {
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    archivedAt: null,
    createdAt: Date.parse("2026-09-10T11:00:00Z"),
    deletedAt: null,
    environmentBranchName: null,
    environmentHostId: null,
    environmentId: "environment-1",
    environmentName: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    id: "thread-default",
    lastReadAt: null,
    latestAttentionAt: Date.parse("2026-09-10T11:00:00Z"),
    originKind: null,
    originPluginId: null,
    parentThreadId: null,
    pinSortKey: null,
    pinnedAt: null,
    projectId: "project-1",
    providerId: "codex",
    queuedWork: "none",
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    sectionId: null,
    sourceThreadId: null,
    status: "idle",
    title: null,
    titleFallback: null,
    updatedAt: Date.parse("2026-09-10T11:00:00Z"),
    visibility: "visible",
  };
  return { ...defaultThread, ...overrides };
}

function makeProviderInteraction<T extends SdkProviderInteraction["payload"]>({
  id,
  threadId,
  turnId,
  createdAt,
  payload,
  expiresAt = null,
}: Pick<SdkProviderInteraction, "id" | "threadId" | "turnId" | "createdAt" | "payload"> &
  Partial<Pick<SdkProviderInteraction, "expiresAt">> & { payload: T }) {
  return {
    createdAt,
    expiresAt,
    id,
    origin: {
      kind: "provider",
      providerId: "codex",
      providerRequestId: `request-${id}`,
      providerThreadId: "provider-thread-1",
    } as const,
    payload,
    providerId: "codex",
    providerRequestId: `request-${id}`,
    providerThreadId: "provider-thread-1",
    resolution: null,
    resolvedAt: null,
    status: "pending" as const,
    statusReason: null,
    threadId,
    turnId,
  };
}

function makeSdk(
  threadPages: readonly (readonly SdkThread[])[],
  interactions: Record<string, readonly SdkInteraction[]>,
): PendingInteractionSdk {
  const pageOffsets: number[] = [];
  let nextOffset = 0;
  for (const page of threadPages) {
    pageOffsets.push(nextOffset);
    nextOffset += page.length;
  }
  const list = vi.fn(async (args: SdkThreadListArgs): Promise<SdkThread[]> => {
    const pageIndex = pageOffsets.indexOf(args?.offset ?? 0);
    return [...(threadPages[pageIndex] ?? [])];
  });
  const interactionList = vi.fn(async ({ threadId }: SdkInteractionListArgs): Promise<SdkInteraction[]> => [
    ...(interactions[threadId] ?? []),
  ]);
  return {
    threads: {
      list,
      interactions: {
        list: interactionList,
      },
    },
  };
}

function makeApproval() {
  return makeProviderInteraction({
    id: "interaction-approval",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: Date.parse("2026-09-10T12:00:00Z"),
    payload: {
      kind: "approval",
      reason: "The worker needs approval to inspect the repository.",
      availableDecisions: ["allow_for_session", "deny", "allow_once"],
      subject: {
        kind: "command",
        itemId: "item-approval",
        command: "cat config.json",
        cwd: null,
        actions: [
          {
            type: "read",
            name: "config",
            command: "cat config.json",
            path: "config.json",
          },
        ],
        sessionGrant: null,
      },
    },
  });
}

function makeQuestion() {
  return makeProviderInteraction({
    id: "interaction-question",
    threadId: "thread-1",
    turnId: "turn-2",
    createdAt: Date.parse("2026-09-10T12:01:00Z"),
    expiresAt: Date.parse("2026-09-10T13:00:00Z"),
    payload: {
      kind: "user_question",
      questions: [
        {
          id: "provider-choice",
          prompt: "Which provider should run this?",
          shortLabel: "Provider",
          allowFreeText: true,
          multiSelect: true,
          options: [
            { value: "provider/claude", label: "Codex", description: "Use the configured Codex provider." },
            { value: "provider/codex", label: "Claude", description: "Use the configured Claude provider." },
          ],
        },
        {
          id: "additional-notes",
          prompt: "Additional context",
          allowFreeText: true,
          multiSelect: false,
        },
      ],
    },
  });
}

function makeCustomInteraction(threadId = "thread-1", id = "interaction-plugin") {
  return makeProviderInteraction({
    id,
    threadId,
    turnId: "turn-3",
    createdAt: Date.parse("2026-09-10T12:02:00Z"),
    payload: {
      kind: "luna/custom-review",
      title: "Custom review",
      data: { secret: "do-not-return-this" },
    },
  });
}

describe("PendingInteractionReader", () => {
  it("links only the configured project/environment and normalizes choices and approvals without raw data", async () => {
    const sdk = makeSdk(
      [[
        makeThread({ id: "thread-1", projectId: "project-1", environmentId: "environment-1", hasPendingInteraction: true }),
        makeThread({
          id: "thread-wrong-environment",
          projectId: "project-1",
          environmentId: "environment-2",
          hasPendingInteraction: true,
        }),
        makeThread({
          id: "thread-wrong-project",
          projectId: "project-2",
          environmentId: "environment-1",
          hasPendingInteraction: true,
        }),
        makeThread({
          id: "thread-no-pending",
          projectId: "project-1",
          environmentId: "environment-1",
          hasPendingInteraction: false,
        }),
      ]],
      {
        "thread-1": [makeApproval(), makeQuestion(), makeCustomInteraction()],
      },
    );
    const reader = createPendingInteractionReader({ sdk, repositoryConfigLookup: async () => scope });

    const projection = await reader.listPendingInteractions("monorepo");

    expect(projection).toEqual({
      repositoryKey: "monorepo",
      interactions: [
        {
          source: "bb-interaction",
          interactionId: "interaction-approval",
          threadId: "thread-1",
          turnId: "turn-1",
          status: "pending",
          kind: "approval",
          title: "BB approval required",
          prompt: "Approval requested for command.\nThe worker needs approval to inspect the repository.\nChoices: allow_for_session, deny, allow_once.",
          metadata: {
            kind: "approval",
            availableDecisions: ["allow_for_session", "deny", "allow_once"],
          },
          createdAt: "2026-09-10T12:00:00.000Z",
          expiresAt: null,
        },
        {
          source: "bb-interaction",
          interactionId: "interaction-question",
          threadId: "thread-1",
          turnId: "turn-2",
          status: "pending",
          kind: "user-question",
          title: "Provider",
          prompt: "Question 1: Which provider should run this?\nChoices:\n- Codex: Use the configured Codex provider.\n- Claude: Use the configured Claude provider.\n\nQuestion 2: Additional context",
          metadata: {
            kind: "user_question",
            questions: [
              {
                id: "provider-choice",
                prompt: "Which provider should run this?",
                shortLabel: "Provider",
                allowFreeText: true,
                multiSelect: true,
                options: [
                  { value: "provider/claude", label: "Codex", description: "Use the configured Codex provider." },
                  { value: "provider/codex", label: "Claude", description: "Use the configured Claude provider." },
                ],
              },
              {
                id: "additional-notes",
                prompt: "Additional context",
                allowFreeText: true,
                multiSelect: false,
              },
            ],
          },
          createdAt: "2026-09-10T12:01:00.000Z",
          expiresAt: "2026-09-10T13:00:00.000Z",
        },
        {
          source: "bb-interaction",
          interactionId: "interaction-plugin",
          threadId: "thread-1",
          turnId: "turn-3",
          status: "pending",
          kind: "plugin",
          title: "Custom review",
          prompt: null,
          metadata: { kind: "plugin" },
          createdAt: "2026-09-10T12:02:00.000Z",
          expiresAt: null,
        },
      ],
    });
    expect(() => pendingInteractionsProjectionSchema.parse(projection)).not.toThrow();
    expect(JSON.stringify(projection)).not.toContain("do-not-return-this");
    expect(sdk.threads.list).toHaveBeenCalledWith({
      archived: false,
      includeHidden: true,
      limit: 100,
      offset: 0,
      projectId: "project-1",
    });
    expect(sdk.threads.interactions.list).toHaveBeenCalledTimes(1);
    expect(sdk.threads.interactions.list).toHaveBeenCalledWith({ threadId: "thread-1" });
  });

  it("reads later thread pages and stops after the first short page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      makeThread({
        id: `thread-first-${index}`,
        projectId: "project-1",
        environmentId: "environment-1",
        hasPendingInteraction: false,
      }),
    );
    const laterPage = [
      makeThread({
        id: "thread-later",
        projectId: "project-1",
        environmentId: "environment-1",
        hasPendingInteraction: true,
      }),
    ];
    const sdk = makeSdk([firstPage, laterPage], {
      "thread-later": [makeCustomInteraction("thread-later", "interaction-later")],
    });
    const reader = createPendingInteractionReader({ sdk, repositoryConfigLookup: async () => scope });

    const projection = await reader.listPendingInteractions("monorepo");

    expect(projection.interactions).toEqual([
      expect.objectContaining({
        interactionId: "interaction-later",
        threadId: "thread-later",
        kind: "plugin",
        title: "Custom review",
      }),
    ]);
    expect(sdk.threads.list).toHaveBeenNthCalledWith(1, {
      archived: false,
      includeHidden: true,
      limit: 100,
      offset: 0,
      projectId: "project-1",
    });
    expect(sdk.threads.list).toHaveBeenNthCalledWith(2, {
      archived: false,
      includeHidden: true,
      limit: 100,
      offset: 100,
      projectId: "project-1",
    });
    expect(sdk.threads.list).toHaveBeenCalledTimes(2);
    expect(sdk.threads.interactions.list).toHaveBeenCalledWith({ threadId: "thread-later" });
  });

  it("rejects a missing repository before calling the SDK", async () => {
    const sdk = makeSdk([[]], {});
    const reader = createPendingInteractionReader({ sdk, repositoryConfigLookup: async () => undefined });

    await expect(reader.listPendingInteractions("monorepo")).rejects.toMatchObject({
      name: "PendingInteractionReaderError",
      code: "repository-not-found",
    });
    expect(sdk.threads.list).not.toHaveBeenCalled();
  });

  it("wraps SDK failures without turning provider errors into projection data", async () => {
    const sdk = makeSdk([[]], {});
    vi.mocked(sdk.threads.list).mockRejectedValueOnce(new Error("sdk failure"));
    const reader = createPendingInteractionReader({ sdk, repositoryConfigLookup: async () => scope });

    await expect(reader.listPendingInteractions("monorepo")).rejects.toMatchObject({
      name: "PendingInteractionReaderError",
      code: "sdk-failure",
      message: "Could not read BB threads for repository 'monorepo'.",
    });
  });
});
