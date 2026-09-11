import { describe, expect, it, vi } from "vitest";
import { createFactoryReadRpcHandlers } from "../src/rpc/read-router.js";
import {
  pickRepositoryFolder,
  probeRepository,
  resolveRepositoryProject,
  slugifyRepositoryKey,
} from "../src/services/repository-quickstart.js";
import type { ReadComposition } from "../src/services/read-composition.js";
import { FakeFileSystem, makeHostsProbe, makeHostTerminals } from "./fakes.js";

const REPO = "/work/newrepo";

function makeSdk(overrides: {
  files?: FakeFileSystem;
  hosts?: { id: string; name?: string; status: string }[];
  pickPath?: string | null;
  pickError?: unknown;
  terminals?: ReturnType<typeof makeHostTerminals>;
  projects?: unknown[];
  createProject?: unknown;
}) {
  const files = overrides.files ?? new FakeFileSystem();
  const hosts = overrides.hosts ?? [{ id: "host-1", name: "Workstation", status: "connected" }];
  const pickFolder = overrides.pickError !== undefined
    ? vi.fn(async () => { throw overrides.pickError; })
    : vi.fn(async () => ({ path: overrides.pickPath ?? null }));
  const projectsList = vi.fn(async () => overrides.projects ?? []);
  const projectsCreate = vi.fn(async (args: { name: string; source: { hostId: string } }) => ({
    id: "proj-new",
    name: args.name,
    sources: [{ ...args.source, type: "local_path" }],
  }));
  return {
    sdk: {
      files: files as unknown,
      hosts: {
        ...makeHostsProbe(files),
        list: vi.fn(async () => hosts),
        pickFolder,
      },
      projects: { list: projectsList, create: projectsCreate },
      terminals: overrides.terminals ?? makeHostTerminals(),
    } as never,
    files,
    pickFolder,
    projectsList,
    projectsCreate,
    terminals: overrides.terminals,
  };
}

describe("slugifyRepositoryKey", () => {
  it("slugifies folder basenames", () => {
    expect(slugifyRepositoryKey("New Repo_")).toBe("new-repo");
    expect(slugifyRepositoryKey("My.App")).toBe("my.app");
    expect(slugifyRepositoryKey("@@@")).toBe("repository");
    expect(slugifyRepositoryKey("")).toBe("repository");
  });
});

describe("pickRepositoryFolder", () => {
  it("auto-selects the sole connected host and returns the picked path", async () => {
    const { sdk, pickFolder } = makeSdk({ pickPath: REPO });
    const result = await pickRepositoryFolder(sdk);
    expect(result).toEqual({ hostId: "host-1", path: REPO });
    expect(pickFolder).toHaveBeenCalledWith({ hostId: "host-1", clientHostId: "host-1" });
  });

  it("uses an explicit hostId when provided", async () => {
    const { sdk, pickFolder } = makeSdk({
      hosts: [
        { id: "host-1", status: "connected" },
        { id: "host-2", status: "connected" },
      ],
      pickPath: REPO,
    });
    const result = await pickRepositoryFolder(sdk, "host-2");
    expect(result.hostId).toBe("host-2");
    expect(pickFolder).toHaveBeenCalledWith({ hostId: "host-2", clientHostId: "host-2" });
  });

  it("returns a null path when the pick is canceled", async () => {
    const { sdk } = makeSdk({ pickPath: null });
    expect(await pickRepositoryFolder(sdk)).toEqual({ hostId: "host-1", path: null });
  });

  it("rejects when no host can be resolved", async () => {
    const { sdk } = makeSdk({
      hosts: [
        { id: "host-1", status: "connected" },
        { id: "host-2", status: "connected" },
      ],
    });
    await expect(pickRepositoryFolder(sdk)).rejects.toThrow(/Several BB hosts/);
  });

  it("rejects when every host is disconnected", async () => {
    const { sdk } = makeSdk({ hosts: [{ id: "host-1", status: "disconnected" }] });
    await expect(pickRepositoryFolder(sdk)).rejects.toThrow(/No connected BB host/);
  });
});

describe("probeRepository", () => {
  it("returns isGitRepo=false for a non-git folder without running host commands", async () => {
    const terminals = makeHostTerminals();
    const { sdk } = makeSdk({ terminals });
    const result = await probeRepository(sdk, { hostId: "host-1", path: "/work/empty" });
    expect(result.isGitRepo).toBe(false);
    expect(result.hasProtocol).toBe(false);
    expect(result.currentBranch).toBeNull();
    expect(result.mainRef).toBe("origin/main");
    expect(result.checkoutSuggestion).toBe("/work/empty-factory");
    expect(result.factoryBranchState).toEqual({ exists: false, checkedOutPath: null });
    expect(terminals.runs).toEqual([]);
  });

  it("detects the default branch, protocol files, project match, and factory worktree", async () => {
    const files = new FakeFileSystem();
    files.seed(".git/HEAD", "ref: refs/heads/main\n", REPO);
    files.seed("plans/factory/foreman.md", "# Foreman\n", REPO);
    const terminals = makeHostTerminals([
      { match: "symbolic-ref", response: { output: "origin/trunk\n" } },
      {
        match: "worktree list",
        response: {
          output: [
            "worktree /work/newrepo",
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            "worktree /work/newrepo-factory",
            "HEAD def456",
            "branch refs/heads/factory",
            "",
          ].join("\n"),
        },
      },
    ]);
    const { sdk } = makeSdk({
      files,
      terminals,
      projects: [
        {
          id: "proj-7",
          name: "Core",
          sources: [{ type: "local_path", hostId: "host-1", path: REPO }],
        },
      ],
    });
    const result = await probeRepository(sdk, { hostId: "host-1", path: REPO });
    expect(result.isGitRepo).toBe(true);
    expect(result.hasProtocol).toBe(true);
    expect(result.currentBranch).toBe("main");
    expect(result.mainRef).toBe("origin/trunk");
    expect(result.suggestedKey).toBe("newrepo");
    expect(result.checkoutSuggestion).toBe(`${REPO}-factory`);
    expect(result.projectMatch).toEqual({ projectId: "proj-7", label: "Core" });
    expect(result.factoryBranchState).toEqual({ exists: true, checkedOutPath: "/work/newrepo-factory" });
    expect(terminals.runs.some((command) => command.includes("symbolic-ref"))).toBe(true);
    expect(terminals.runs.some((command) => command.includes("worktree list"))).toBe(true);
  });

  it("falls back to the loose origin/HEAD ref when symbolic-ref fails", async () => {
    const files = new FakeFileSystem();
    files.seed(".git/HEAD", "ref: refs/heads/main\n", REPO);
    files.seed(".git/refs/remotes/origin/HEAD", "ref: refs/remotes/origin/trunk\n", REPO);
    const terminals = makeHostTerminals([
      { match: "symbolic-ref", response: { exitCode: 1, output: "fatal\n" } },
    ]);
    const { sdk } = makeSdk({ files, terminals });
    const result = await probeRepository(sdk, { hostId: "host-1", path: REPO });
    expect(result.mainRef).toBe("origin/trunk");
  });

  it("falls back to origin/main when no default branch can be resolved", async () => {
    const files = new FakeFileSystem();
    files.seed(".git/HEAD", "ref: refs/heads/main\n", REPO);
    const terminals = makeHostTerminals([
      { match: "symbolic-ref", response: { exitCode: 1, output: "fatal\n" } },
    ]);
    const { sdk } = makeSdk({ files, terminals });
    const result = await probeRepository(sdk, { hostId: "host-1", path: REPO });
    expect(result.mainRef).toBe("origin/main");
    expect(result.projectMatch).toBeNull();
  });

  it("does not match a project on a different host or path", async () => {
    const files = new FakeFileSystem();
    files.seed(".git/HEAD", "ref: refs/heads/main\n", REPO);
    const { sdk } = makeSdk({
      files,
      projects: [
        { id: "proj-a", name: "Other host", sources: [{ type: "local_path", hostId: "host-2", path: REPO }] },
        { id: "proj-b", name: "Other path", sources: [{ type: "local_path", hostId: "host-1", path: "/work/other" }] },
        { id: "proj-c", name: "No path", sources: [{ type: "local_path", hostId: "host-1", path: null }] },
      ],
    });
    const result = await probeRepository(sdk, { hostId: "host-1", path: REPO });
    expect(result.projectMatch).toBeNull();
  });

  it("skips the project lookup gracefully when projects.list fails", async () => {
    const files = new FakeFileSystem();
    files.seed(".git/HEAD", "ref: refs/heads/main\n", REPO);
    const { sdk, projectsList } = makeSdk({ files });
    projectsList.mockRejectedValue(new Error("projects unavailable"));
    const result = await probeRepository(sdk, { hostId: "host-1", path: REPO });
    expect(result.isGitRepo).toBe(true);
    expect(result.projectMatch).toBeNull();
  });
});

describe("resolveRepositoryProject", () => {
  it("returns an existing project without creating one", async () => {
    const { sdk, projectsCreate } = makeSdk({
      projects: [
        { id: "proj-7", name: "Core", sources: [{ type: "local_path", hostId: "host-1", path: REPO }] },
      ],
    });
    const result = await resolveRepositoryProject(sdk, { hostId: "host-1", path: REPO, name: "newrepo" });
    expect(result).toEqual({ projectId: "proj-7", label: "Core", created: false });
    expect(projectsCreate).not.toHaveBeenCalled();
  });

  it("creates a project with the local-path source when nothing matches", async () => {
    const { sdk, projectsCreate } = makeSdk({ projects: [] });
    const result = await resolveRepositoryProject(sdk, { hostId: "host-1", path: REPO, name: "newrepo" });
    expect(projectsCreate).toHaveBeenCalledWith({
      name: "newrepo",
      source: { type: "local_path", hostId: "host-1", path: REPO },
    });
    expect(result).toEqual({ projectId: "proj-new", label: "newrepo", created: true });
  });

  it("rejects when projects.list fails", async () => {
    const { sdk, projectsList } = makeSdk({});
    projectsList.mockRejectedValue(new Error("projects unavailable"));
    await expect(resolveRepositoryProject(sdk, { hostId: "host-1", path: REPO, name: "newrepo" }))
      .rejects.toThrow(/projects unavailable/);
  });
});

describe("quickstart RPC routing", () => {
  it("routes factory_pick_folder and factory_probe_repository as non-durable reads", async () => {
    const files = new FakeFileSystem();
    files.seed(".git/HEAD", "ref: refs/heads/main\n", REPO);
    files.seed("plans/factory/foreman.md", "# Foreman\n", REPO);
    const terminals = makeHostTerminals([
      { match: "symbolic-ref", response: { output: "origin/main\n" } },
    ]);
    const { sdk } = makeSdk({ files, terminals, pickPath: REPO });
    const handlers = createFactoryReadRpcHandlers(
      () => ({ sdk }) as unknown as ReadComposition,
    );
    const picked = await handlers.factory_pick_folder({});
    expect(picked).toEqual({ hostId: "host-1", path: REPO });
    const probed = await handlers.factory_probe_repository({ hostId: "host-1", path: REPO });
    expect(probed).toMatchObject({
      hostId: "host-1",
      path: REPO,
      isGitRepo: true,
      hasProtocol: true,
      suggestedKey: "newrepo",
      mainRef: "origin/main",
      checkoutSuggestion: `${REPO}-factory`,
    });
  });
});
