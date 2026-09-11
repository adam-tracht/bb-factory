// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FactoryActionResult,
  RepositoryProbe,
} from "../src/contracts.js";
import type { FileLinkRenderer } from "../src/ui/primitives.js";
import type { ViewContext } from "../src/ui/context.js";
import {
  acceptExistingCheckoutOffer,
  AddRepositoryView,
  createRegistrationSession,
  runRegistration,
  type RegistrationContext,
  type RegistrationPlan,
} from "../src/ui/views/repositories.js";

const h = createElement;
const REPO = "/work/newrepo";
const WORKTREE = "/work/newrepo-factory";
const REV = { gitCommit: "abc123", protocolDigest: "d".repeat(64), fileDigests: {} };

const baseProbe: RepositoryProbe = {
  hostId: "host-1",
  path: REPO,
  isGitRepo: true,
  hasProtocol: false,
  currentBranch: "main",
  suggestedKey: "newrepo",
  mainRef: "origin/main",
  checkoutSuggestion: WORKTREE,
  projectMatch: null,
  factoryBranchState: { exists: false, checkedOutPath: null },
};

function makeCtx(overrides: Partial<ViewContext> = {}): ViewContext {
  return {
    repository: {
      repositoryKey: "demo",
      repositoryRoot: "/work/demo",
      connectedHostId: "host-1",
      checkoutPath: "/work/demo-factory",
      factoryBranch: "factory",
      mainRef: "origin/main",
    },
    environmentId: null,
    projectId: null,
    dispatchPaused: false,
    revision: null,
    fileLink: (() => null) satisfies FileLinkRenderer,
    feedback: null,
    pendingTarget: null,
    onOpenSection: vi.fn(),
    onOpenRepository: vi.fn(),
    onOpenRun: vi.fn(),
    onOpenThread: vi.fn(),
    onOpenProject: vi.fn(),
    onAction: vi.fn(),
    updateSettings: vi.fn(),
    updateRepository: vi.fn(),
    addRepository: vi.fn(async () => ({ ok: true as const, message: "registered" })),
    loadRegistryOptions: vi.fn(async () => ({
      hosts: [{ hostId: "host-1", label: "Workstation", status: "connected" }],
      projects: [],
    })),
    runAction: vi.fn(),
    pickRepositoryFolder: vi.fn(async () => ({ hostId: "host-1", path: REPO })),
    probeRepository: vi.fn(async () => baseProbe),
    resolveRepositoryProject: vi.fn(async () => ({ projectId: "proj-9", label: "newrepo", created: true })),
    ...overrides,
  };
}

function provisionResult(overrides: Record<string, unknown> = {}): FactoryActionResult {
  return {
    ok: true,
    revision: null,
    result: {
      status: "accepted",
      message: "Created the factory worktree.",
      revision: REV,
      runId: null,
      leaseId: null,
      queueItemId: null,
      action: "provision-checkout",
      questionId: null,
      interactionId: null,
      mode: "worktree",
      outcome: "provisioned",
      checkoutPath: WORKTREE,
      branch: "factory",
      blockingWorktreePath: null,
      branchCreated: true,
      branchExisted: false,
      baseRef: "origin/main",
      ...overrides,
    },
  } as FactoryActionResult;
}

function scaffoldResult(): FactoryActionResult {
  return {
    ok: true,
    revision: null,
    result: {
      status: "accepted",
      message: "Wrote the plans/factory protocol files.",
      revision: REV,
      runId: null,
      leaseId: null,
      queueItemId: null,
      action: "scaffold-protocol",
      questionId: null,
      interactionId: null,
      outcome: "written",
      written: ["plans/factory/foreman.md"],
      skipped: [],
      commitSha: "def456",
    },
  } as FactoryActionResult;
}

function makePlan(overrides: Partial<RegistrationPlan> = {}): RegistrationPlan {
  return {
    hostId: "host-1",
    root: REPO,
    repositoryKey: "newrepo",
    mainRef: "origin/main",
    mode: "worktree",
    existingCheckoutPath: null,
    scaffoldPlanned: true,
    projectName: "newrepo",
    ...overrides,
  };
}

function makeRegistrationCtx(overrides: Partial<RegistrationContext> = {}) {
  const calls: string[] = [];
  const ctx: RegistrationContext = {
    runAction: vi.fn(async (request) => {
      calls.push(request.action.kind);
      if (request.action.kind === "provision-checkout") return provisionResult();
      if (request.action.kind === "scaffold-protocol") return scaffoldResult();
      throw new Error(`unexpected action ${request.action.kind}`);
    }),
    resolveRepositoryProject: vi.fn(async () => {
      calls.push("resolve");
      return { projectId: "proj-9", label: "newrepo", created: true };
    }),
    addRepository: vi.fn(async () => {
      calls.push("register");
      return { ok: true as const, message: "registered" };
    }),
    ...overrides,
  };
  return { ctx, calls };
}

let keySeq = 0;
const keygen = () => `00000000-0000-4000-8000-${String(++keySeq).padStart(12, "0")}`;

describe("runRegistration", () => {
  it("provisions, resolves, registers paused, and scaffolds in order", async () => {
    const { ctx, calls } = makeRegistrationCtx();
    const session = createRegistrationSession(makePlan());
    const outcome = await runRegistration(ctx, session, () => {}, keygen);
    expect(outcome).toBe("done");
    expect(calls).toEqual(["provision-checkout", "resolve", "register", "scaffold-protocol"]);
    expect(ctx.addRepository).toHaveBeenCalledWith({
      configuration: {
        repositoryKey: "newrepo",
        repositoryRoot: REPO,
        connectedHostId: "host-1",
        checkoutPath: WORKTREE,
        mainRef: "origin/main",
      },
      projectId: "proj-9",
      dispatchPaused: true,
    });
    const registrationInput = vi.mocked(ctx.addRepository).mock.calls[0]![0];
    expect("environmentId" in registrationInput).toBe(false);
    expect(session.steps.map((step) => step.status)).toEqual(["done", "done", "done", "done"]);
  });

  it("skips scaffolding when the checkout already has protocol files", async () => {
    const { ctx, calls } = makeRegistrationCtx();
    const session = createRegistrationSession(makePlan({ scaffoldPlanned: false }));
    const outcome = await runRegistration(ctx, session, () => {}, keygen);
    expect(outcome).toBe("done");
    expect(calls).toEqual(["provision-checkout", "resolve", "register"]);
    expect(session.steps.find((step) => step.id === "protocol")!.status).toBe("skipped");
  });

  it("skips scaffolding with an explanation when direct mode lands off-branch", async () => {
    const { ctx, calls } = makeRegistrationCtx();
    vi.mocked(ctx.runAction).mockImplementation(async (request) => {
      calls.push(request.action.kind);
      return provisionResult({
        mode: "direct",
        outcome: "off-branch",
        checkoutPath: REPO,
        branch: "main",
        branchCreated: false,
      });
    });
    const session = createRegistrationSession(makePlan({ mode: "direct" }));
    const outcome = await runRegistration(ctx, session, () => {}, keygen);
    expect(outcome).toBe("done");
    expect(calls).toEqual(["provision-checkout", "resolve", "register"]);
    const protocol = session.steps.find((step) => step.id === "protocol")!;
    expect(protocol.status).toBe("skipped");
    expect(protocol.detail).toContain("'main'");
  });

  it("surfaces branch-in-use and resumes through the existing checkout", async () => {
    const { ctx } = makeRegistrationCtx({
      runAction: vi.fn(async (request) => {
        const action = request.action;
        if (action.kind === "provision-checkout") {
          if (action.repositoryRoot === "/elsewhere") {
            return provisionResult({
              mode: "direct",
              outcome: "verified",
              checkoutPath: "/elsewhere",
              branchCreated: false,
            });
          }
          return provisionResult({
            outcome: "branch-in-use",
            checkoutPath: null,
            blockingWorktreePath: "/elsewhere",
            branchCreated: false,
            message: "The 'factory' branch is already checked out.",
          });
        }
        return scaffoldResult();
      }),
    });
    const session = createRegistrationSession(makePlan());
    const first = await runRegistration(ctx, session, () => {}, keygen);
    expect(first).toBe("attention");
    expect(session.offer).toEqual({ blockingWorktreePath: "/elsewhere" });

    acceptExistingCheckoutOffer(session);
    const second = await runRegistration(ctx, session, () => {}, keygen);
    expect(second).toBe("done");
    const provisionRequests = vi.mocked(ctx.runAction).mock.calls
      .map((call) => call[0].action)
      .filter((action) => action.kind === "provision-checkout");
    expect(provisionRequests[1]).toMatchObject({ mode: "direct", repositoryRoot: "/elsewhere" });
    expect(ctx.addRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: expect.objectContaining({ checkoutPath: "/elsewhere" }),
      }),
    );
  });

  it("treats a duplicate registration as a completed resume point", async () => {
    const { ctx } = makeRegistrationCtx({
      addRepository: vi.fn(async () => ({
        ok: false as const,
        error: { category: "conflict" as const, message: "Repository 'newrepo' is already registered." },
      })),
    });
    const session = createRegistrationSession(makePlan());
    const outcome = await runRegistration(ctx, session, () => {}, keygen);
    expect(outcome).toBe("done");
    expect(session.steps.find((step) => step.id === "register")!.status).toBe("done");
  });

  it("resumes after a mid-flow failure without repeating completed steps", async () => {
    let registrations = 0;
    const { ctx } = makeRegistrationCtx({
      addRepository: vi.fn(async () => {
        registrations += 1;
        if (registrations === 1) {
          return { ok: false as const, error: { category: "internal" as const, message: "settings write failed" } };
        }
        return { ok: true as const, message: "registered" };
      }),
    });
    const session = createRegistrationSession(makePlan());
    const first = await runRegistration(ctx, session, () => {}, keygen);
    expect(first).toBe("failed");
    expect(session.steps.find((step) => step.id === "register")!.status).toBe("failed");

    const second = await runRegistration(ctx, session, () => {}, keygen);
    expect(second).toBe("done");
    const provisionCalls = vi.mocked(ctx.runAction).mock.calls
      .filter((call) => call[0].action.kind === "provision-checkout");
    expect(provisionCalls).toHaveLength(1);
    expect(ctx.resolveRepositoryProject).toHaveBeenCalledTimes(1);
    expect(ctx.addRepository).toHaveBeenCalledTimes(2);
  });
});

describe("AddRepositoryView", () => {
  afterEach(() => cleanup());

  it("picks a folder, reviews derived values, confirms, and registers paused", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      runAction: vi.fn(async (request) => {
        calls.push(request.action.kind);
        return request.action.kind === "provision-checkout" ? provisionResult() : scaffoldResult();
      }),
      resolveRepositoryProject: vi.fn(async () => {
        calls.push("resolve");
        return { projectId: "proj-9", label: "newrepo", created: true };
      }),
      addRepository: vi.fn(async () => {
        calls.push("register");
        return { ok: true as const, message: "registered" };
      }),
    });
    const onDone = vi.fn();
    render(h(AddRepositoryView, { ctx, onDone, onCancel: vi.fn() }));

    fireEvent.click(await screen.findByRole("button", { name: "Choose repository folder" }));
    const keyInput = (await screen.findByLabelText("Repository key")) as HTMLInputElement;
    expect(keyInput.value).toBe("newrepo");
    expect((screen.getByLabelText("Main ref") as HTMLInputElement).value).toBe("origin/main");
    expect((screen.getByLabelText("Dedicated factory worktree") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/initialized on 'factory'/)).toBeTruthy();
    expect(screen.queryByLabelText("Environment")).toBeNull();
    expect(screen.queryByLabelText("Project")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Register repository" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(WORKTREE);
    expect(dialog.textContent).toContain("paused");
    fireEvent.click(within(dialog).getByRole("button", { name: "Register repository" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("newrepo"));
    expect(calls).toEqual(["provision-checkout", "resolve", "register", "scaffold-protocol"]);
    expect(ctx.addRepository).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchPaused: true }),
    );
  });

  it("shows a readable error for a non-git folder and stays on the pick stage", async () => {
    const ctx = makeCtx({
      probeRepository: vi.fn(async () => ({ ...baseProbe, isGitRepo: false, hasProtocol: false, currentBranch: null })),
    });
    render(h(AddRepositoryView, { ctx, onDone: vi.fn(), onCancel: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose repository folder" }));
    expect(await screen.findByText(/is not a Git repository/)).toBeTruthy();
    expect(screen.queryByLabelText("Repository key")).toBeNull();
  });

  it("notes a canceled pick without failing", async () => {
    const ctx = makeCtx({
      pickRepositoryFolder: vi.fn(async () => ({ hostId: "host-1", path: null })),
    });
    render(h(AddRepositoryView, { ctx, onDone: vi.fn(), onCancel: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose repository folder" }));
    expect(await screen.findByText("Folder pick canceled.")).toBeTruthy();
    expect(ctx.probeRepository).not.toHaveBeenCalled();
  });

  it("defaults to the existing factory checkout when the branch lives elsewhere", async () => {
    const ctx = makeCtx({
      probeRepository: vi.fn(async () => ({
        ...baseProbe,
        factoryBranchState: { exists: true, checkedOutPath: "/other/newrepo-factory" },
      })),
    });
    render(h(AddRepositoryView, { ctx, onDone: vi.fn(), onCancel: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose repository folder" }));
    const existing = (await screen.findByLabelText("Use the existing factory checkout")) as HTMLInputElement;
    expect(existing.checked).toBe(true);
    expect(((await screen.findByLabelText("Dedicated factory worktree")) as HTMLInputElement).disabled).toBe(true);
  });

  it("resolves the branch-in-use offer during submit and finishes", async () => {
    let provisionCalls = 0;
    const ctx = makeCtx({
      runAction: vi.fn(async (request) => {
        if (request.action.kind === "scaffold-protocol") return scaffoldResult();
        provisionCalls += 1;
        return provisionCalls === 1
          ? provisionResult({
              outcome: "branch-in-use",
              checkoutPath: null,
              blockingWorktreePath: WORKTREE,
              branchCreated: false,
              message: "The 'factory' branch is already checked out.",
            })
          : provisionResult({ mode: "direct", outcome: "verified", checkoutPath: WORKTREE, branchCreated: false });
      }),
      probeRepository: vi.fn(async () => baseProbe),
    });
    const onDone = vi.fn();
    render(h(AddRepositoryView, { ctx, onDone, onCancel: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose repository folder" }));
    await screen.findByLabelText("Repository key");
    fireEvent.click(screen.getByRole("button", { name: "Register repository" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Register repository" }));

    fireEvent.click(await screen.findByRole("button", { name: "Use the existing factory checkout" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("newrepo"));
    expect(ctx.addRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: expect.objectContaining({ checkoutPath: WORKTREE }),
      }),
    );
  });

  it("shows a readable failure and retries the registration", async () => {
    let registrations = 0;
    const ctx = makeCtx({
      runAction: vi.fn(async (request) =>
        request.action.kind === "provision-checkout" ? provisionResult() : scaffoldResult()),
      addRepository: vi.fn(async () => {
        registrations += 1;
        if (registrations === 1) {
          return { ok: false as const, error: { category: "internal" as const, message: "settings write failed" } };
        }
        return { ok: true as const, message: "registered" };
      }),
    });
    const onDone = vi.fn();
    render(h(AddRepositoryView, { ctx, onDone, onCancel: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose repository folder" }));
    await screen.findByLabelText("Repository key");
    fireEvent.click(screen.getByRole("button", { name: "Register repository" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Register repository" }));

    expect(await screen.findByText("settings write failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("newrepo"));
    expect(ctx.addRepository).toHaveBeenCalledTimes(2);
  });

  it("blocks submission on an invalid repository key", async () => {
    const ctx = makeCtx();
    render(h(AddRepositoryView, { ctx, onDone: vi.fn(), onCancel: vi.fn() }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose repository folder" }));
    const keyInput = (await screen.findByLabelText("Repository key")) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "BadKey" } });
    fireEvent.click(screen.getByRole("button", { name: "Register repository" }));
    expect(await screen.findByText(/Lowercase letters/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ctx.runAction).not.toHaveBeenCalled();
  });

  it("renders an error notice when registry options fail to load", async () => {
    const ctx = makeCtx({
      loadRegistryOptions: vi.fn(async () => {
        throw new Error("options unavailable");
      }),
    });
    render(h(AddRepositoryView, { ctx, onDone: vi.fn(), onCancel: vi.fn() }));
    expect(await screen.findByText("options unavailable")).toBeTruthy();
  });
});
