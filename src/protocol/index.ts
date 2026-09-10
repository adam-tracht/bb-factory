export { discoverManagedRepositories, discoverRepositoryConfigurations } from "./discovery.js";
export {
  createConnectedHostDependencyResolver,
  parseQualifiedDependency,
  parseRepositoryPolicy,
  staticDependencyResolver,
} from "./dependencies.js";
export { ProtocolError, asProtocolError, type ProtocolErrorCode } from "./errors.js";
export {
  confinedPath,
  decodeFileContent,
  digestText,
  listFiles,
  normalizeAbsolutePath,
  readTextFile,
  relativePathFrom,
  type ProtocolFileReadArgs,
  type ProtocolFileReadResult,
  type ProtocolFiles,
  type ProtocolPathEntry,
  type ProtocolPathListArgs,
  type ProtocolPathListResult,
  type TextFile,
} from "./files.js";
export { parseCurrentState, parseDashboard, parseQueue, parseQuestions, parseRunRecord } from "./markdown.js";
export {
  createProtocolReader,
  protocolPath,
  relativeProtocolPath,
  RepositoryProtocolReader,
  staticMergeReader,
} from "./reader.js";
export type {
  CanonicalDashboardProjection,
  ConnectedHostDependencyResolverOptions,
  DashboardRowProjection,
  ImmutableRunRecord,
  ProtocolDependencyResolver,
  ProtocolDependencyResolverInput,
  ProtocolDependencySource,
  ProtocolDashboardSummary,
  ProtocolMergeProjection,
  ProtocolMergeReader,
  ProtocolProjection,
  ProtocolRepositoryLookup,
  ProtocolRepositoryPolicy,
  ProtocolRepositoryRegistry,
  ProtocolReaderOptions,
} from "./types.js";
