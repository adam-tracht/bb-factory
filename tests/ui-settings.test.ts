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
import { RepositoryLandingView } from "../src/ui/views/repositories.js";

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
    runAction: vi.fn(),
    pickRepositoryFolder: vi.fn(),
    probeRepository: vi.fn(),
    resolveRepositoryProject: vi.fn(),
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
  it("keeps read-only repository identity fields inside a collapsed disclosure", () => {
    renderSettings();
    // Live operational pieces stay visible at the top level.
    expect(screen.getByText("online")).toBeTruthy();
    expect(screen.getByText("Dispatch is active for this repo.")).toBeTruthy();
    // Identity fields mount lazily: absent until the disclosure is expanded.
    expect(screen.queryByText("Repository key")).toBeNull();
    expect(screen.queryByTitle("Copy /work/demo")).toBeNull();
    expect(screen.queryByTitle("Copy project-1")).toBeNull();

    fireEvent.click(screen.getByText("Repository details").closest("details")!.querySelector("summary")!);
    expect(screen.getByText("demo")).toBeTruthy();
    expect(screen.getByTitle("Copy /work/demo")).toBeTruthy();
    expect(screen.getByTitle("Copy /work/demo-factory")).toBeTruthy();
    expect(screen.getByTitle("Copy factory")).toBeTruthy();
    expect(screen.getByTitle("Copy origin/main")).toBeTruthy();
    expect(screen.getByTitle("Copy host-1")).toBeTruthy();
    expect(screen.getByTitle("Copy project-1")).toBeTruthy();
    expect(screen.getByTitle("Copy environment-1")).toBeTruthy();
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

  it("toggles repository dispatch through a labeled Pause/Resume dispatch button", async () => {
    const ctx = makeCtx({ dispatchPaused: true });
    renderSettings({ ctx });
    expect(screen.getByText("Dispatch is paused for this repo.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume dispatch" }));
    expect(ctx.updateRepository).toHaveBeenCalledWith({ repositoryKey: "demo", dispatchPaused: false });
    expect(await screen.findByText("saved")).toBeTruthy();
  });

  it("offers Pause dispatch while repo dispatch is active", async () => {
    const ctx = makeCtx();
    renderSettings({ ctx });
    fireEvent.click(screen.getByRole("button", { name: "Pause dispatch" }));
    expect(ctx.updateRepository).toHaveBeenCalledWith({ repositoryKey: "demo", dispatchPaused: true });
    expect(await screen.findByText("saved")).toBeTruthy();
  });

  it("sets and clears the optional display name through the existing repository mutation", async () => {
    const ctx = makeCtx({
      displayName: "Old name",
      updateRepository: vi.fn(async (input: Parameters<ViewContext["updateRepository"]>[0]) => ({
        ok: true as const,
        message: input.displayName === null
          ? "Display name cleared for 'demo'."
          : "Display name saved as 'Friendly repo'.",
      })),
    });
    renderSettings({ ctx });
    const input = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(input.value).toBe("Old name");

    fireEvent.change(input, { target: { value: "Friendly repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Save display name" }));
    await waitFor(() => expect(ctx.updateRepository).toHaveBeenCalledWith({
      repositoryKey: "demo",
      displayName: "Friendly repo",
    }));
    expect(await screen.findByText("Display name saved as 'Friendly repo'.")).toBeTruthy();

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save display name" }));
    await waitFor(() => expect(ctx.updateRepository).toHaveBeenLastCalledWith({
      repositoryKey: "demo",
      displayName: null,
    }));
    expect(await screen.findByText("Display name cleared for 'demo'.")).toBeTruthy();
  });

  it("blocks an overlong display name before the Settings mutation", () => {
    const ctx = makeCtx({ displayName: "Old name" });
    renderSettings({ ctx });
    const input = screen.getByLabelText("Display name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "x".repeat(65) } });

    expect(screen.getByRole("button", { name: "Save display name" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Use 64 characters or fewer")).toBeTruthy();
    expect(ctx.updateRepository).not.toHaveBeenCalled();
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

  it("sends the dispatch mode in the settings patch", () => {
    const ctx = makeCtx();
    renderSettings({ ctx });

    fireEvent.click(screen.getByRole("button", { name: "Paused" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(ctx.updateSettings).toHaveBeenCalledWith({ dispatchMode: "paused" });
  });

  it("warns on an invalid cron and blocks saving it", () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "not a cron" } });
    expect(screen.getByText("Not a valid five-field cron")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("keeps padded form controls inside the card with border-box sizing", () => {
    renderSettings();
    // Every w-full control also pads horizontally; without border-box its
    // rendered width exceeds the card on phone-width viewports.
    const labels = [
      "Schedule",
      "Time zone",
      "Night-window end hour",
      "Runtime cap (minutes)",
      "Minimum start gap (minutes)",
      "Concurrency limit",
      "Provider preference",
    ];
    for (const label of labels) {
      const control = screen.getByLabelText(label);
      expect(control.className).toContain("w-full");
      expect(control.className).toContain("box-border");
    }
    // The dispatch toggle stays inline-flex (content-sized), never stretched.
    const toggle = screen.getByRole("group", { name: "Dispatch mode" });
    expect(toggle.className).toContain("inline-flex");
  });

  it("describes a valid cron preset and lists upcoming fire times", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Nightly" }));
    expect((screen.getByLabelText("Schedule") as HTMLInputElement).value).toBe("*/10 1-5 * * *");
    expect(screen.getByText("Every 10 minutes between 01:00 and 05:59, every day")).toBeTruthy();
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
    // A failed save never claims the field saved, and the draft input survives.
    expect(screen.queryByText("Saved")).toBeNull();
    expect((screen.getByLabelText("Schedule") as HTMLInputElement).value).toBe("5 * * * *");
  });

  it("clears only the edited field's server error after a failed save", async () => {
    const ctx = makeCtx({
      updateSettings: vi.fn(async () => ({
        ok: false as const,
        error: {
          category: "invalid-input" as const,
          message: "Settings conflict",
          fieldErrors: {
            scheduleCron: ["cron rejected by server"],
            runtimeCapSeconds: ["cap rejected by server"],
          },
        },
      })),
    });
    renderSettings({ ctx });
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "5 * * * *" } });
    fireEvent.change(screen.getByLabelText("Runtime cap (minutes)"), { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("cron rejected by server")).toBeTruthy();
    expect(await screen.findByText("cap rejected by server")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "10 * * * *" } });
    expect(screen.queryByText("cron rejected by server")).toBeNull();
    expect(screen.getByText("cap rejected by server")).toBeTruthy();
    expect(screen.queryByText("Settings conflict")).toBeNull();
    expect((screen.getByLabelText("Schedule") as HTMLInputElement).value).toBe("10 * * * *");
  });

  it("marks only the fields in the patch as Saving then Saved on real mutation completion", async () => {
    let resolveSave!: (result: { ok: true; message: string }) => void;
    const ctx = makeCtx({
      updateSettings: vi.fn(() => new Promise<{ ok: true; message: string }>((resolve) => { resolveSave = resolve; })),
    });
    renderSettings({ ctx });

    fireEvent.change(screen.getByLabelText("Runtime cap (minutes)"), { target: { value: "240" } });
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));

    expect(await screen.findAllByText("Saving...")).toHaveLength(2);
    expect((screen.getByLabelText("Runtime cap (minutes)") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Schedule") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Time zone") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Paused" }) as HTMLButtonElement).disabled).toBe(false);

    resolveSave({ ok: true, message: "saved" });
    expect(await screen.findAllByText("Saved")).toHaveLength(2);
    expect((screen.getByLabelText("Runtime cap (minutes)") as HTMLInputElement).disabled).toBe(false);

    // The Saved marks clear after their short window.
    await waitFor(() => expect(screen.queryByText("Saved")).toBeNull(), { timeout: 3000 });
  });

  it("keeps Saved marks across a same-repository refresh and resets on a repository switch", async () => {
    const ctx = makeCtx();
    const view = renderSettings({ ctx });
    fireEvent.change(screen.getByLabelText("Runtime cap (minutes)"), { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeTruthy();

    // Same-repository reload reflecting the write: mark survives, no dirty bar.
    view.rerender(h(SettingsView, {
      projection: {
        ...settingsProjection,
        settings: { ...settingsProjection.settings, runtimeCapSeconds: 14400 },
      },
      health: healthProjection,
      ctx,
    }));
    expect(screen.getByText("Saved")).toBeTruthy();
    expect((screen.getByLabelText("Runtime cap (minutes)") as HTMLInputElement).value).toBe("240");
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    // A different repository's projection reseeds the form and drops the mark.
    view.rerender(h(SettingsView, {
      projection: {
        ...settingsProjection,
        settings: { ...settingsProjection.settings, repositoryKey: "other", runtimeCapSeconds: 3600 },
      },
      health: healthProjection,
      ctx: makeCtx({ repository: { ...repository, repositoryKey: "other" } }),
    }));
    expect(screen.queryByText("Saved")).toBeNull();
    expect((screen.getByLabelText("Runtime cap (minutes)") as HTMLInputElement).value).toBe("60");
  });

  it("clears a field's Saved mark when the field is edited again", async () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText("Runtime cap (minutes)"), { target: { value: "240" } });
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findAllByText("Saved")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "0 9 * * 1" } });
    expect(screen.getAllByText("Saved")).toHaveLength(1);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("does not leak storage details in helper copy", () => {
    renderSettings();
    expect(screen.queryByText(/Stored as seconds/)).toBeNull();
    expect(screen.getByText("Minimum 1 minute.")).toBeTruthy();
  });

  it("falls back to the raw cron when the schedule cannot be described as a sentence", () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "1-59/2 * * * *" } });
    const fallback = screen.getByText("1-59/2 * * * *");
    expect(fallback.tagName).toBe("CODE");
  });

  it("does not double-punctuate the provider warning", () => {
    const health: HealthProjection = {
      ...healthProjection,
      providers: healthProjection.providers.map((provider) =>
        provider.providerId === "codex"
          ? { ...provider, availability: "limited" as const, lastError: "weekly quota." }
          : provider),
    };
    renderSettings({ health });
    expect(screen.getByText("Preferred provider is limited: weekly quota.")).toBeTruthy();
    expect(screen.queryByText(/\.\./)).toBeNull();
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

  it("lists every reported provider in the preference dropdown", () => {
    const health: HealthProjection = {
      ...healthProjection,
      providers: [...healthProjection.providers, {
        providerId: "acp-opencode",
        model: "opencode",
        reasoningLevel: "high",
        availability: "available",
        limitedUntil: null,
        activeThreadCount: 0,
        lastError: null,
      }],
    };
    renderSettings({ health });
    const options = Array.from((screen.getByLabelText("Provider preference") as HTMLSelectElement).options)
      .map((option) => option.textContent);
    expect(options).toEqual([
      "alternate (rotate providers)",
      "codex (available)",
      "claude-code (limited)",
      "acp-opencode (available)",
    ]);
  });

  it("keeps a stored provider preference when it is no longer reported", () => {
    renderSettings({
      projection: {
        ...settingsProjection,
        settings: { ...settingsProjection.settings, providerPreference: "acp-devin" },
      },
    });
    expect(screen.getByRole("option", { name: "acp-devin (not reported)" })).toBeTruthy();
  });

  it("exposes a model and thinking control for the pinned provider and saves the configured default", async () => {
    const ctx = makeCtx();
    renderSettings({ ctx });
    // The host picker is unbound in tests, so the fallback model input +
    // thinking select render, seeded from the host-reported values.
    const modelInput = screen.getByLabelText("Default model") as HTMLInputElement;
    const thinkingSelect = screen.getByLabelText("Default thinking level") as HTMLSelectElement;
    expect(modelInput.placeholder).toBe("gpt-5");
    expect(modelInput.value).toBe("");
    expect(thinkingSelect.value).toBe("medium");

    fireEvent.change(modelInput, { target: { value: "gpt-5-codex" } });
    fireEvent.change(thinkingSelect, { target: { value: "xhigh" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));

    expect(ctx.updateSettings).toHaveBeenCalledWith({
      providerModelDefaults: { codex: { model: "gpt-5-codex", reasoningLevel: "xhigh" } },
    });
    expect(await screen.findByText("saved")).toBeTruthy();
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("hides the model default controls while the preference rotates", () => {
    renderSettings({
      projection: {
        ...settingsProjection,
        settings: { ...settingsProjection.settings, providerPreference: undefined },
      },
    });
    expect((screen.getByLabelText("Provider preference") as HTMLSelectElement).value).toBe("alternate");
    expect(screen.queryByLabelText("Default model")).toBeNull();
    expect(screen.queryByLabelText("Default thinking level")).toBeNull();
    expect(screen.queryByText("Default model + thinking")).toBeNull();
  });

  it("preserves stored defaults for other providers in the wholesale patch", async () => {
    const ctx = makeCtx();
    renderSettings({
      ctx,
      projection: {
        ...settingsProjection,
        settings: {
          ...settingsProjection.settings,
          providerModelDefaults: { "acp-devin": { model: "devin-large", reasoningLevel: "high" as const } },
        },
      },
    });
    fireEvent.change(screen.getByLabelText("Default model"), { target: { value: "gpt-5-codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    expect(ctx.updateSettings).toHaveBeenCalledWith({
      providerModelDefaults: {
        "acp-devin": { model: "devin-large", reasoningLevel: "high" },
        codex: { model: "gpt-5-codex", reasoningLevel: "medium" },
      },
    });
  });

  it("clears a stored default with Use host default and patches null when the map empties", async () => {
    const ctx = makeCtx();
    renderSettings({
      ctx,
      projection: {
        ...settingsProjection,
        settings: {
          ...settingsProjection.settings,
          providerModelDefaults: { codex: { model: "gpt-5-codex", reasoningLevel: "low" as const } },
        },
      },
    });
    expect((screen.getByLabelText("Default model") as HTMLInputElement).value).toBe("gpt-5-codex");
    fireEvent.click(screen.getByRole("button", { name: "Use host default" }));
    expect((screen.getByLabelText("Default model") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    expect(ctx.updateSettings).toHaveBeenCalledWith({ providerModelDefaults: null });
  });

  it("blocks saving a provider default with an empty model name", () => {
    renderSettings();
    const modelInput = screen.getByLabelText("Default model");
    fireEvent.change(modelInput, { target: { value: "gpt-5-codex" } });
    fireEvent.change(modelInput, { target: { value: "  " } });
    expect(screen.getByText("Enter a model name.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("releases the save block when the invalid entry is no longer editable", () => {
    const ctx = makeCtx();
    renderSettings({ ctx });
    fireEvent.change(screen.getByLabelText("Default model"), { target: { value: "  " } });
    expect(screen.getByText("Enter a model name.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Provider preference"), { target: { value: "alternate" } });
    expect(screen.queryByText("Enter a model name.")).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("maps nested server fieldErrors onto the provider default row", async () => {
    const ctx = makeCtx({
      updateSettings: vi.fn(async () => ({
        ok: false as const,
        error: {
          category: "invalid-input" as const,
          message: "The updated settings are invalid",
          fieldErrors: { "providerModelDefaults.codex.model": ["model rejected by server"] },
        },
      })),
    });
    renderSettings({ ctx });
    fireEvent.change(screen.getByLabelText("Default model"), { target: { value: "gpt-5-codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("model rejected by server")).toBeTruthy();
  });

  it("renders a stored default tolerantly when the host no longer reports the pinned provider", () => {
    renderSettings({
      projection: {
        ...settingsProjection,
        settings: {
          ...settingsProjection.settings,
          providerPreference: "acp-devin",
          providerModelDefaults: { "acp-devin": { model: "devin-large", reasoningLevel: "high" as const } },
        },
      },
    });
    expect(screen.getByRole("option", { name: "acp-devin (not reported)" })).toBeTruthy();
    expect(screen.getByText("devin-large · high")).toBeTruthy();
    expect(screen.getByText("(provider not reported)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use host default" })).toBeTruthy();
    expect(screen.queryByLabelText("Default model")).toBeNull();
  });

  it("explains that an unreported pinned provider has no catalog without a stored default", () => {
    renderSettings({
      projection: {
        ...settingsProjection,
        settings: { ...settingsProjection.settings, providerPreference: "acp-devin" },
      },
    });
    expect(screen.getByText(/does not report this provider/)).toBeTruthy();
    expect(screen.queryByLabelText("Default model")).toBeNull();
  });

  it("shows the rotation editor only while the preference alternates", () => {
    renderSettings();
    expect(screen.queryByLabelText("Add provider to rotation")).toBeNull();

    fireEvent.change(screen.getByLabelText("Provider preference"), { target: { value: "alternate" } });
    expect(screen.getByLabelText("Add provider to rotation")).toBeTruthy();
    expect(screen.getByText("No rotation set: dispatch rotates across every reported provider.")).toBeTruthy();
  });

  it("adds, reorders, and saves a provider rotation in list order", async () => {
    const ctx = makeCtx();
    renderSettings({
      ctx,
      projection: {
        ...settingsProjection,
        settings: { ...settingsProjection.settings, providerPreference: "alternate" },
      },
    });
    const addSelect = screen.getByLabelText("Add provider to rotation") as HTMLSelectElement;
    fireEvent.change(addSelect, { target: { value: "codex" } });
    // A listed member leaves the add options.
    expect(Array.from(addSelect.options).map((option) => option.value)).not.toContain("codex");
    fireEvent.change(addSelect, { target: { value: "claude-code" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Move claude-code up" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    expect(ctx.updateSettings).toHaveBeenCalledWith({ providerRotation: ["claude-code", "codex"] });
    expect(await screen.findByText("saved")).toBeTruthy();
  });

  it("moves a rotation member down in list order", async () => {
    const ctx = makeCtx();
    renderSettings({
      ctx,
      projection: {
        ...settingsProjection,
        settings: {
          ...settingsProjection.settings,
          providerPreference: "alternate",
          providerRotation: ["codex", "claude-code"],
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Move codex down" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    expect(ctx.updateSettings).toHaveBeenCalledWith({ providerRotation: ["claude-code", "codex"] });
  });

  it("renders a stored rotation id the host no longer reports and stays removable", () => {
    renderSettings({
      projection: {
        ...settingsProjection,
        settings: {
          ...settingsProjection.settings,
          providerPreference: "alternate",
          providerRotation: ["codex", "acp-devin"],
        },
      },
    });
    expect(screen.getByText("acp-devin")).toBeTruthy();
    expect(screen.getByText("(not reported)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove acp-devin from rotation" }));
    expect(screen.queryByText("acp-devin")).toBeNull();
    // One remaining member cannot form a rotation: the row explains and Save blocks.
    expect(screen.getByText(/at least 2 providers/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears a stored rotation back to unset with a null patch", async () => {
    const ctx = makeCtx();
    renderSettings({
      ctx,
      projection: {
        ...settingsProjection,
        settings: {
          ...settingsProjection.settings,
          providerPreference: "alternate",
          providerRotation: ["codex", "claude-code"],
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear rotation" }));
    expect(screen.getByText(/No rotation set/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    expect(ctx.updateSettings).toHaveBeenCalledWith({ providerRotation: null });
  });

  it("shows a member's configured model default in the rotation list", () => {
    renderSettings({
      projection: {
        ...settingsProjection,
        settings: {
          ...settingsProjection.settings,
          providerPreference: "alternate",
          providerRotation: ["codex", "claude-code"],
          providerModelDefaults: { codex: { model: "gpt-5-codex", reasoningLevel: "xhigh" } },
        },
      },
    });
    expect(screen.getByText("gpt-5-codex · xhigh")).toBeTruthy();
  });

  it("maps nested server fieldErrors onto the rotation row", async () => {
    const ctx = makeCtx({
      updateSettings: vi.fn(async () => ({
        ok: false as const,
        error: {
          category: "invalid-input" as const,
          message: "The updated settings are invalid",
          fieldErrors: { "providerRotation.1": ["rotation rejected by server"] },
        },
      })),
    });
    renderSettings({
      ctx,
      projection: {
        ...settingsProjection,
        settings: { ...settingsProjection.settings, providerPreference: "alternate" },
      },
    });
    fireEvent.change(screen.getByLabelText("Add provider to rotation"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Add provider to rotation"), { target: { value: "claude-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("rotation rejected by server")).toBeTruthy();
  });
});

describe("RepositoryLandingView", () => {
  it("uses the display name for the visible repository card while selecting by key", () => {
    const onSelect = vi.fn();
    render(h(RepositoryLandingView, {
      repositories: [makeSelection("demo", { displayName: "Demo app" })],
      onSelect,
      onAddRepository: vi.fn(),
    }));
    expect(screen.getByText("Demo app")).toBeTruthy();
    fireEvent.click(screen.getByText("Demo app").closest("button") as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("demo");
  });

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
    expect(await screen.findByText("3 need attention")).toBeTruthy();
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
