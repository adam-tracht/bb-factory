import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  repositoryKeySchema,
  type PickFolderResult,
  type ProbeRepositoryInput,
  type ProjectSourceMatch,
  type RepositoryProbe,
  type ResolveProjectInput,
  type ResolveProjectResult,
  type FactoryBranchState,
} from "../contracts.js";
import { runHostCommand, shellQuote } from "../actions/host-command.js";
import { normalizeHostPath, parseWorktreeList, sameHostPath } from "../actions/provision.js";
import { asProtocolError } from "../protocol/errors.js";
import { confinedPath } from "../protocol/files.js";
import { readCheckoutBranch } from "./live-health.js";

type QuickstartSdk = Pick<BbPluginApi["sdk"], "files" | "hosts" | "projects" | "terminals">;

const FACTORY_BRANCH = "factory";
const PROBE_TIMEOUT_MS = 30_000;
const FOREMAN_RELATIVE_PATH = "plans/factory/foreman.md";
const ORIGIN_HEAD_RELATIVE_PATH = ".git/refs/remotes/origin/HEAD";

/** Lowercase slug for a folder name; falls back when nothing valid remains. */
export function slugifyRepositoryKey(folderName: string): string {
  const slug = folderName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "")
    .slice(0, 64)
    .replace(/[^a-z0-9]+$/u, "");
  return repositoryKeySchema.safeParse(slug).success ? slug : "repository";
}

function folderBasename(path: string): string {
  const segments = normalizeHostPath(path).split(/[\\/]/u).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? path;
}

/**
 * Opens the native folder picker on a connected host. Without hostId the sole
 * connected host wins; zero or several hosts are caller-resolved errors.
 */
export async function pickRepositoryFolder(sdk: QuickstartSdk, hostId?: string): Promise<PickFolderResult> {
  let resolved = hostId;
  if (resolved === undefined) {
    const hosts = await sdk.hosts.list();
    const connected = hosts.filter((host) => host.status === "connected");
    if (connected.length === 0) {
      throw new Error("No connected BB host can show a folder picker.");
    }
    if (connected.length > 1) {
      throw new Error("Several BB hosts are connected; choose a host before picking a folder.");
    }
    resolved = connected[0]!.id;
  }
  const response = await sdk.hosts.pickFolder({ hostId: resolved, clientHostId: resolved });
  return { hostId: resolved, path: response.path };
}

/** Remote default branch: `symbolic-ref refs/remotes/origin/HEAD`, then the loose ref file, then origin/main. */
async function probeMainRef(sdk: QuickstartSdk, hostId: string, root: string): Promise<string> {
  const symbolic = await runHostCommand(sdk.terminals, {
    hostId,
    cwd: root,
    command: `git -C ${shellQuote(root)} symbolic-ref --quiet --short refs/remotes/origin/HEAD`,
    title: "factory remote HEAD probe",
    timeoutMs: PROBE_TIMEOUT_MS,
  }).catch(() => null);
  if (symbolic !== null && symbolic.exitCode === 0 && symbolic.output.trim() !== "") {
    return symbolic.output.trim();
  }
  try {
    const content = (await sdk.files.read({ hostId, path: `${root}/${ORIGIN_HEAD_RELATIVE_PATH}` })).content;
    const ref = /^ref:\s*refs\/remotes\/(\S+)\s*$/m.exec(content.trim())?.[1];
    if (ref !== undefined) return ref;
  } catch {
    // Packed refs or a linked-worktree .git pointer leave no loose ref to read.
  }
  return "origin/main";
}

async function probeFactoryBranchState(sdk: QuickstartSdk, hostId: string, root: string): Promise<FactoryBranchState> {
  const listed = await runHostCommand(sdk.terminals, {
    hostId,
    cwd: root,
    command: `git -C ${shellQuote(root)} worktree list --porcelain`,
    title: "factory worktree list",
    timeoutMs: PROBE_TIMEOUT_MS,
  }).catch(() => null);
  if (listed === null || listed.exitCode !== 0) {
    return { exists: false, checkedOutPath: null };
  }
  const holder = parseWorktreeList(listed.output).find((entry) => entry.branch === FACTORY_BRANCH);
  return holder
    ? { exists: true, checkedOutPath: normalizeHostPath(holder.path) }
    : { exists: false, checkedOutPath: null };
}

async function matchProjectBySource(sdk: QuickstartSdk, hostId: string, root: string): Promise<ProjectSourceMatch | null> {
  const projects = await sdk.projects.list();
  const match = projects.find((project) =>
    project.sources.some((source) =>
      source.type === "local_path" && source.hostId === hostId && sameHostPath(source.path, root)));
  return match ? { projectId: match.id, label: match.name } : null;
}

/**
 * Read-only probe behind the add wizard's second stage. Terminal and project
 * reads degrade to safe defaults; a missing path or .git marker ends the probe
 * early with isGitRepo false, and a foreman.md read maps file-not-found to
 * hasProtocol false while real read failures still throw.
 */
export async function probeRepository(sdk: QuickstartSdk, input: ProbeRepositoryInput): Promise<RepositoryProbe> {
  const hostId = input.hostId;
  const root = normalizeHostPath(input.path);
  const checkoutSuggestion = `${root}-factory`;
  const suggestedKey = slugifyRepositoryKey(folderBasename(root));

  const existence = (await sdk.hosts.pathsExist({ hostId, paths: [root, `${root}/.git`] })).existence;
  const isGitRepo = existence[root] === true && existence[`${root}/.git`] === true;
  if (!isGitRepo) {
    return {
      hostId,
      path: root,
      isGitRepo: false,
      hasProtocol: false,
      currentBranch: null,
      suggestedKey,
      mainRef: "origin/main",
      checkoutSuggestion,
      projectMatch: null,
      factoryBranchState: { exists: false, checkedOutPath: null },
    };
  }

  let hasProtocol = false;
  try {
    await sdk.files.read({ hostId, path: confinedPath(root, FOREMAN_RELATIVE_PATH), rootPath: root });
    hasProtocol = true;
  } catch (error) {
    const failure = asProtocolError(error, { path: FOREMAN_RELATIVE_PATH });
    if (failure.code !== "file-not-found") throw failure;
  }

  const [currentBranch, mainRef, factoryBranchState, projectMatch] = await Promise.all([
    readCheckoutBranch(sdk, hostId, root).catch(() => null),
    probeMainRef(sdk, hostId, root),
    probeFactoryBranchState(sdk, hostId, root),
    matchProjectBySource(sdk, hostId, root).catch(() => null),
  ]);

  return {
    hostId,
    path: root,
    isGitRepo: true,
    hasProtocol,
    currentBranch,
    suggestedKey,
    mainRef,
    checkoutSuggestion,
    projectMatch,
    factoryBranchState,
  };
}

/**
 * Source-match or create the BB project for a picked folder. Listing failures
 * throw here (not in the advisory probe) so a retry cannot create a duplicate
 * after a lost create response: the created project's own source re-matches.
 */
export async function resolveRepositoryProject(sdk: QuickstartSdk, input: ResolveProjectInput): Promise<ResolveProjectResult> {
  const root = normalizeHostPath(input.path);
  const existing = await matchProjectBySource(sdk, input.hostId, root);
  if (existing) return { projectId: existing.projectId, label: existing.label, created: false };
  const created = await sdk.projects.create({
    name: input.name,
    source: { type: "local_path", hostId: input.hostId, path: root },
  });
  return { projectId: created.id, label: created.name, created: true };
}
