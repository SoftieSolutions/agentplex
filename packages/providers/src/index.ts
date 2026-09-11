export { createProviderRegistry } from './provider-registry.js';
export type { ProviderLookup, ProviderRegistry } from './provider-registry.js';

export type {
  AuthProbe,
  AuthState,
  DiscoveredSession,
  DiscoveryProblem,
  InstallPlan,
  InstallRequest,
  InstalledProvider,
  Launch,
  LaunchPlan,
  LoginRequest,
  OneShotPlan,
  OneShotRead,
  ProviderAdapter,
  ProviderDiscovery,
  ProviderProvisioning,
  ResumeRequest,
  SpawnRequest,
  StatusObservation,
  TranscriptSignal,
  VersionProbe,
} from './provider-adapter.js';

export { createProviderPreflight } from './preflight.js';
export type { ProviderPreflight, ProviderPreflightDependencies } from './preflight.js';

export { CLAUDE_PROJECTS_DIRECTORY, createClaudeAdapter } from './claude-adapter.js';
export type { ClaudeAdapterDependencies } from './claude-adapter.js';
export {
  CLAUDE_COMMAND,
  CLAUDE_CONFIG_DIR,
  CLAUDE_DEFAULT_STORE_DIRECTORY,
  CLAUDE_SCRUB_PREFIXES,
  planClaudeLaunch,
} from './claude-launch.js';
export { CLAUDE_PACKAGE, NPM_COMMAND, createClaudeProvisioning } from './claude-provisioning.js';
export {
  CLAUDE_REGISTRY_STATUSES,
  CLAUDE_SESSIONS_DIRECTORY,
  PID_RECYCLE_TOLERANCE_MS,
  parseClaudeRegistryEntry,
  readClaudeRegistry,
  resolveWithRegistry,
} from './claude-registry.js';
export type {
  ClaudeRegistry,
  ClaudeRegistryEntry,
  ClaudeRegistryStatus,
  ResolvedObservation,
} from './claude-registry.js';
export { parseClaudeTranscript } from './claude-transcript.js';
export type { ClaudeTranscript, ClaudeTranscriptParse } from './claude-transcript.js';

export type { DirectoryEntry, DirectoryRead, ProviderFiles } from './provider-files.js';
export { nodeProviderFiles } from './node-provider-files.js';

export { parseWorkingDirectory } from './working-directory.js';
export type { WorkingDirectory } from './working-directory.js';

export { discoverStoreSessions } from './store-discovery.js';
export type {
  SessionLiveness,
  StoreDiscoveryDependencies,
  StoreDiscoveryProblem,
  StoreSessions,
} from './store-discovery.js';

export {
  STORE_FILE_NAME,
  ensureStoreIdentity,
  ensureStores,
  parseStoreFile,
} from './store-identity.js';
export type {
  DirectoryState,
  FileCreate,
  FileRead,
  StoreFileParse,
  StoreFileSystem,
  StoreIdentity,
  StoreIdentityDependencies,
} from './store-identity.js';
export { nodeStoreFileSystem } from './node-store-files.js';

export { ensureServerIdentity, readServerIdentity } from './server-identity.js';
export type {
  ServerIdentity,
  ServerIdentityDependencies,
  ServerIdentityResult,
} from './server-identity.js';

export type { ProcessProbe } from './process-probe.js';
export { createNodeProcessProbe } from './node-process-probe.js';
export type { NodeProcessProbeDependencies } from './node-process-probe.js';

export type { ProgramResolver } from './program-resolver.js';
export { createNodeProgramResolver } from './node-program-resolver.js';

export { describeProcessRequest } from './operations/process-runner.js';
export type {
  CompletedProcess,
  ProcessOutcome,
  ProcessRequest,
  ProcessRunner,
} from './operations/process-runner.js';
export {
  createNodeDetachedSpawner,
  createNodeProcessRunner,
} from './operations/node-process-runner.js';
export type { NodeProcessRunnerDependencies } from './operations/node-process-runner.js';

export { startDetached } from './operations/detached-spawn.js';
export type {
  DetachedOperation,
  DetachedSpawner,
  DetachedStart,
} from './operations/detached-spawn.js';

export { describeIssues, runOperation } from './operations/operation.js';
export type {
  Argv,
  Operation,
  OperationOutcome,
  OperationRefusal,
  OperationSummary,
} from './operations/operation.js';

export {
  processStartTimeOperation,
  processStartTimeRequestSchema,
} from './operations/process-start-time.js';
export type { ProcessStartTime, ProcessStartTimeRequest } from './operations/process-start-time.js';

export {
  providerAuthStateOperation,
  providerInstallOperation,
  providerInstallRequestSchema,
  providerVersionOperation,
} from './operations/provider-provisioning-operations.js';
export type {
  ProviderInstallRequest,
  ProviderProvisioningRequest,
} from './operations/provider-provisioning-operations.js';

export { runSetupOperation } from './operations/setup-operation.js';
export type { SetupOperation, SetupPlanned } from './operations/setup-operation.js';
export { createSetupOperationRegistry } from './operations/setup-operation-registry.js';
export type {
  SetupOperationRegistry,
  SetupOperationRegistryDependencies,
} from './operations/setup-operation-registry.js';
