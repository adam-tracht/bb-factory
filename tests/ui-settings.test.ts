// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HealthProjection,
  RegistryOptionsProjection,
  RepositoryConfiguration,
  RepositoryRevision,
  RepositorySelection,
  SettingsProjection,
} from "../src/contracts.js";
import type { ViewContext } from "../src/ui/context.js";
import type { FileLinkRenderer } from "../src/ui/primitives.js";
import { SettingsView } from "../src/ui/views/settings.js";
import { AddRepositoryView, RepositoryLandingView } from "../src/ui/views/repositories.js";

const h = createElement;

const revision: RepositoryRevision = {
  gitCommit: "abcdef1234567890",
  protocolDigest: "a".repeat(64),
  fileDigests: { "plans/factory/queue.md": "b".repeat(64) },
};

const repository: RepositoryConfiguration = {
  repositoryKey: "demo",
  repositoryRoot: "/work/demo",
  connectedHostId: "host-1",
  checkoutPath: "/work/demo-factory",
  factoryBranch: "factory",
  mainRef: "origin/main",
};

const settingsProjection: SettingsProjection = {
  settings: {
    repositoryKey: "demo",
    repositoryRoot: "/work/demo",
    connectedHostId: "host-1",
    checkoutPath: "/work/demo-factory",
    scheduleCron: "0 * * * *",
    timeZone: "server-local",
    nightWindowEndHour: 6,
    runtimeCapSeconds: 10800,
    providerPreference: "codex",
    minimumStartGapSeconds: 3600,
    concurrencyLimit: 1,
    dispatchMode: "enabled",
  },
  validation: { valid: true, fieldErrors: {} },
  dispatch: { mode: "enabled", repositoryPaused: false, acceptingNewRuns: true, activeRunCount: 0, reason: null },
};

const healthProjection: HealthProjection = {
  repositoryKey: "demo",
  providers: [
    {
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      availability: "available",
      limitedUntil: null,
      activeThreadCount: 0,
      lastError: null,
    },
    {
      providerId: "claude-code",
      model: "opus",
      reasoningLevel: "high",
      availability: "limited",
      limitedUntil: null,
      activeThreadCount: 1,
      lastError: "weekly quota",
    },
  ],
  host: {
    hostId: "host-1",
    status: "online",
    checkoutExists: true,
    branch: "factory",
    requiredTools: {},
    browserAvailable: null,
    dbtStudioAvailable: null,
    ok: true,
    reasons: [],
  },
};

const registryOptions: RegistryOptionsProjection = {
  hosts: [{ hostId: "host-1", label: "Workstation", status: "online" }],
  projects: [{ projectId: "proj-1", label: "Core" }],
};

const stubFileLink: FileLinkRenderer = ({ target, className, children }) =>
  h("a", { href: "#stub", className, "data-target": JSON.stringify(target) }, children);

function makeCtx(overrides: Partial<ViewContext> = {}): ViewContext {
  return {
    repository,
    environmentId: "environment-1",
    projectId: "project-1",
    dispatchPaused: false,
    revision,
    fileLink: stubFileLink,
    feedback: null,
    pendingTarget: null,
    onOpenSection: vi.fn(),
    onOpenRepository: vi.fn(),
    onOpenRun: vi.fn(),
    onOpenThread: vi.fn(),
    onOpenProject: vi.fn(),
    onAction: vi.fn(),
    updateSettings: vi.fn(async () => ({ ok: true as const, message: "saved" })),
    updateRepository: vi.fn(async () => ({ ok: true as const, message: "saved" })),
    addRepository: vi.fn(async () => ({ ok: true as const, message: "saved" })),
    loadRegistryOptions: vi.fn(async () => registryOptions),
    ...overrides,
  };
}

function makeSelection(repositoryKey: string, overrides: Partial<RepositorySelection> = {}): RepositorySelection {
  return {
    configuration: {
      repositoryKey,
      repositoryRoot: `/work/${repositoryKey}`,
      connectedHostId: "host-1",
      checkoutPath: `/work/${repositoryKey}-factory`,
      factoryBranch: "factory",
      mainRef: "origin/main",
    },
    projectId: "project-1",
    environmentId: "environment-1",
    dispatchPaused: false,
    selected: false,
    available: true,
    reasons: [],
    ...overrides,
  };
}

function renderSettings(overrides: { projection?: SettingsProjection; health?: HealthProjection | null; ctx?: ViewContext } = {}) {
  return render(h(SettingsView, {
    projection: overrides.projection ?? settingsProjection,
    health: overrides.health === undefined ? healthProjection : overrides.health,
    ctx: overrides.ctx ?? makeCtx(),
  }));
}

afterEach(() => cleanup());

describe("SettingsView", () => {
  it("renders the read-only repository identity card with copy buttons", () => {
    renderSettings();
    expect(screen.getByText("demo")).toBeTruthy();
    expect(screen.getByTitle("Copy /work/demo")).toBeTruthy();
    expect(screen.getByTitle("Copy /work/demo-factory")).toBeTruthy();
    expect(screen.getByTitle("Copy factory")).toBeTruthy();
    expect(screen.getByTitle("Copy origin/main")).toBeTruthy();
    expect(screen.getByTitle("Copy host-1")).toBeTruthy();
    expect(screen.getByTitle("Copy project-1")).toBeTruthy();
    expect(screen.getByTitle("Copy environment-1")).toBeTruthy();
    expect(screen.getByText("online")).toBeTruthy();
    expect(screen.getByText("Dispatch active for this repo")).toBeTruthy();
  });

  it("shows the first host reason when the host is unhealthy", () => {
    const health: HealthProjection = {
      ...healthProjection,
      host: { ...healthProjection.host, ok: false, status: "offline", reasons: ["host is offline"] },
    };
    renderSettings({ health });
    expect(screen.getByText("offline")).toBeTruthy();
    expect(screen.getByText("host is offline")).toBeTruthy();
  });

  it("toggles repository dispatch through updateRepository", async () => {
    const ctx = makeCtx({ dispatchPaused: true });
    renderSettings({ ctx });
    fireEvent.click(screen.getByRole("button", { name: "Dispatch paused for this repo" }));
    expect(ctx.updateRepository).toHaveBeenCalledWith({ repositoryKey: "demo", dispatchPaused: false });
    expect(await screen.findByText("saved")).toBeTruthy();
  });

  it("shows the dirty bar on edit, restores on Discard, and saves a converted patch", async () => {
    const ctx = makeCtx();
    renderSettings({ ctx });

    expect(screen.queryByText("Unsaved changes")).toBeNull();
    fireEvent.change(screen.getByLabelText("Runtime cap (minutes)"), { target: { value: "240" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect((screen.getByLabelText("Runtime cap (minutes)") as HTMLInputElement).value).toBe("180");

    fireEvent.change(screen.getByLabelText("Runtime cap (minutes)"), { target: { value: "240" } });
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Applies to demo on the next dispatch cycle. A run in progress is not affected.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(ctx.updateSettings).toHaveBeenCalledWith({ scheduleCron: null, runtimeCapSeconds: 14400 });
    expect(await screen.findByText("saved")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
  });

  it("warns on an invalid cron and blocks saving it", () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "not a cron" } });
    expect(screen.getByText("Not a valid five-field cron")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("describes a valid cron preset and lists upcoming fire times", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Nightly" }));
    expect((screen.getByLabelText("Schedule") as HTMLInputElement).value).toBe("*/10 1-5 * * *");
    expect(screen.getByText(/every 10 min/)).toBeTruthy();
    expect(screen.getByText(/Next:/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
    expect(screen.getByText("Manual only: no scheduled runs.")).toBeTruthy();
  });

  it("maps server fieldErrors onto inputs and shows the error message", async () => {
    const ctx = makeCtx({
      updateSettings: vi.fn(async () => ({
        ok: false as const,
        error: {
          category: "invalid-input" as const,
          message: "Settings conflict",
          fieldErrors: { scheduleCron: ["cron rejected by server"] },
        },
      })),
    });
    renderSettings({ ctx });
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "5 * * * *" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Settings conflict")).toBeTruthy();
    expect(await screen.findByText("cron rejected by server")).toBeTruthy();
  });

  it("warns when concurrency is raised while the preferred provider is limited", () => {
    const health: HealthProjection = {
      ...healthProjection,
      providers: healthProjection.providers.map((provider) =>
        provider.providerId === "codex" ? { ...provider, availability: "limited" as const } : provider),
    };
    renderSettings({ health });
    fireEvent.change(screen.getByLabelText("Concurrency limit"), { target: { value: "3" } });
    expect(screen.getByText("The preferred provider is limited; >1 may still serialize")).toBeTruthy();
  });
});

describe("RepositoryLandingView", () => {
  it("renders a row per repository with lazy attention counts and selects on click", async () => {
    const onSelect = vi.fn();
    const onAddRepository = vi.fn();
    const loadSummary = vi.fn(async (repositoryKey: string) => ({
      attention: repositoryKey === "demo" ? 3 : 0,
      dispatch: null,
      error: null,
    }));
    render(h(RepositoryLandingView, {
      repositories: [makeSelection("demo", { dispatchPaused: true }), makeSelection("other")],
      onSelect,
      onAddRepository,
      loadSummary,
    }));

    expect(screen.getByText("Repositories")).toBeTruthy();
    expect(screen.getByText("demo")).toBeTruthy();
    expect(screen.getByText("other")).toBeTruthy();
    expect(screen.getByText("paused")).toBeTruthy();
    expect(await screen.findByText("3")).toBeTruthy();
    expect(loadSummary).toHaveBeenCalledWith("demo");
    expect(loadSummary).toHaveBeenCalledWith("other");

    fireEvent.click(screen.getByText("demo").closest("button") as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("demo");
  });

  it("shows a danger marker when the summary load reports an error", async () => {
    render(h(RepositoryLandingView, {
      repositories: [makeSelection("demo")],
      onSelect: vi.fn(),
      onAddRepository: vi.fn(),
      loadSummary: vi.fn(async () => ({ attention: 0, dispatch: null, error: "reader exploded" })),
    }));
    const marker = await screen.findByText("!");
    expect(marker.getAttribute("title")).toBe("reader exploded");
  });

  it("shows the empty state with an add action", () => {
    const onAddRepository = vi.fn();
    render(h(RepositoryLandingView, {
      repositories: [],
      onSelect: vi.fn(),
      onAddRepository,
    }));
    expect(screen.getByText("No repositories configured")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Add repository" })[0]);
    expect(onAddRepository).toHaveBeenCalled();
  });
});

describe("AddRepositoryView", () => {
  it("loads options, validates, confirms, and reports onDone", async () => {
    const ctx = makeCtx();
    const onDone = vi.fn();
    const onCancel = vi.fn();
    render(h(AddRepositoryView, { ctx, onDone, onCancel }));

    const keyInput = await screen.findByLabelText("Repository key");
    fireEvent.change(keyInput, { target: { value: "newrepo" } });
    fireEvent.change(screen.getByLabelText("Connected host"), { target: { value: "host-1" } });
    fireEvent.change(screen.getByLabelText("Repository root"), { target: { value: "/work/newrepo" } });
    fireEvent.change(screen.getByLabelText("Checkout path"), { target: { value: "/work/newrepo-factory" } });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "proj-1" } });
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "env_1" } });
    expect((screen.getByLabelText("Main ref") as HTMLInputElement).value).toBe("origin/main");
    expect(screen.getByText("New repositories start paused until you turn dispatch on.")).toBeTruthy();
    expect(screen.getByText(/"repositoryKey": "newrepo"/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Creates a registry entry.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add repository" }));

    expect(ctx.addRepository).toHaveBeenCalledWith({
      configuration: {
        repositoryKey: "newrepo",
        repositoryRoot: "/work/newrepo",
        connectedHostId: "host-1",
        checkoutPath: "/work/newrepo-factory",
        mainRef: "origin/main",
      },
      projectId: "proj-1",
      environmentId: "env_1",
      dispatchPaused: true,
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("newrepo"));
  });

  it("blocks submission on invalid input without calling addRepository", async () => {
    const ctx = makeCtx();
    render(h(AddRepositoryView, { ctx, onDone: vi.fn(), onCancel: vi.fn() }));
    await screen.findByLabelText("Repository key");

    fireEvent.change(screen.getByLabelText("Repository key"), { target: { value: "BadKey" } });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));

    expect(screen.getByText(/Lowercase letters/)).toBeTruthy();
    expect(screen.getByText("Choose a connected host.")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(ctx.addRepository).not.toHaveBeenCalled();
  });

  it("shows server errors and maps fieldErrors onto fields", async () => {
    const ctx = makeCtx({
      addRepository: vi.fn(async () => ({
        ok: false as const,
        error: {
          category: "conflict" as const,
          message: "Registry conflict",
          fieldErrors: { "configuration.repositoryKey": ["already registered"] },
        },
      })),
    });
    render(h(AddRepositoryView, { ctx, onDone: vi.fn(), onCancel: vi.fn() }));
    await screen.findByLabelText("Repository key");

    fireEvent.change(screen.getByLabelText("Repository key"), { target: { value: "demo" } });
    fireEvent.change(screen.getByLabelText("Connected host"), { target: { value: "host-1" } });
    fireEvent.change(screen.getByLabelText("Repository root"), { target: { value: "/work/demo" } });
    fireEvent.change(screen.getByLabelText("Checkout path"), { target: { value: "/work/demo-factory" } });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "proj-1" } });
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "env_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Add repository" }));

    expect(await screen.findByText("Registry conflict")).toBeTruthy();
    expect(await screen.findByText("already registered")).toBeTruthy();
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
