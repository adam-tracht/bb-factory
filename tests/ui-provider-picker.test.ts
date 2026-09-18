// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HealthProjection,
  RepositoryConfiguration,
  RepositoryRevision,
  SettingsProjection,
} from "../src/contracts.js";
import type { ViewContext } from "../src/ui/context.js";
import type { FileLinkRenderer } from "../src/ui/primitives.js";
import { SettingsView } from "../src/ui/views/settings.js";

const h = createElement;

const picker = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

// Bind the host-owned picker so the pinned-provider branch renders it instead
// of the text-input fallback covered in ui-settings.test.ts.
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { createElement: ce } = await import("react");
  return {
    ...actual,
    experimental_ProviderModelPicker: (props: Record<string, unknown>) => {
      picker.calls.push(props);
      return ce("div", { "data-testid": "bound-model-picker" });
    },
  };
});

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

const codexProvider = {
  providerId: "codex",
  model: "gpt-5",
  reasoningLevel: "medium" as const,
  availability: "available" as const,
  limitedUntil: null,
  activeThreadCount: 0,
  lastError: null,
};

const healthProjection: HealthProjection = {
  repositoryKey: "demo",
  providers: [
    codexProvider,
    { ...codexProvider, providerId: "claude-code", model: "opus", reasoningLevel: "high" },
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
    loadRegistryOptions: vi.fn(async () => ({ hosts: [], projects: [] })),
    runAction: vi.fn(),
    pickRepositoryFolder: vi.fn(),
    probeRepository: vi.fn(),
    resolveRepositoryProject: vi.fn(),
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

function lastPickerProps() {
  return picker.calls.at(-1) as {
    value: { providerId: string; model: string; reasoningLevel: string; serviceTier?: string };
    onChange(value: unknown): void;
    routing?: unknown;
    allowProviderChange?: boolean;
  };
}

beforeEach(() => {
  picker.calls.length = 0;
});
afterEach(() => cleanup());

describe("SettingsView with the bound provider picker", () => {
  it("pins the picker to the preferred provider through environment routing", () => {
    renderSettings();
    expect(screen.getByTestId("bound-model-picker")).toBeTruthy();
    expect(screen.queryByLabelText("Default model")).toBeNull();
    const props = lastPickerProps();
    expect(props.value).toEqual({ providerId: "codex", model: "gpt-5", reasoningLevel: "medium" });
    expect(props.allowProviderChange).toBe(false);
    expect(props.routing).toEqual({ kind: "environment", environmentId: "environment-1" });
  });

  it("routes catalog resolution through the host when the view has no environment", () => {
    renderSettings({ ctx: makeCtx({ environmentId: null }) });
    expect(lastPickerProps().routing).toEqual({ kind: "host", hostId: "host-1" });
  });

  it("seeds the picker from a stored default and writes back under the pinned key", async () => {
    const ctx = makeCtx();
    renderSettings({
      ctx,
      projection: {
        ...settingsProjection,
        settings: {
          ...settingsProjection.settings,
          providerModelDefaults: {
            codex: { model: "gpt-5-codex", reasoningLevel: "low" as const },
            "claude-code": { model: "opus", reasoningLevel: "high" as const },
          },
        },
      },
    });
    expect(lastPickerProps().value).toEqual({ providerId: "codex", model: "gpt-5-codex", reasoningLevel: "low" });

    act(() => {
      lastPickerProps().onChange({ providerId: "codex", model: "gpt-5.1-codex", reasoningLevel: "xhigh" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));
    expect(ctx.updateSettings).toHaveBeenCalledWith({
      providerModelDefaults: {
        codex: { model: "gpt-5.1-codex", reasoningLevel: "xhigh" },
        "claude-code": { model: "opus", reasoningLevel: "high" },
      },
    });
  });

  it("falls back to text inputs when the reported provider has no model catalog", () => {
    renderSettings({
      health: {
        ...healthProjection,
        providers: [
          { ...codexProvider, model: "unavailable" },
          { ...codexProvider, providerId: "claude-code", model: "opus", reasoningLevel: "high" },
        ],
      },
    });
    expect(screen.queryByTestId("bound-model-picker")).toBeNull();
    expect((screen.getByLabelText("Default model") as HTMLInputElement).placeholder).toBe("model name");
    expect(screen.getByLabelText("Default thinking level")).toBeTruthy();
  });
});
