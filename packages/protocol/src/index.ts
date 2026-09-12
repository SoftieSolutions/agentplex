export { PROTOCOL_VERSION, checkProtocolVersion } from './version.js';
export type { ProtocolVersionMismatch } from './version.js';

export { frameParser, parseTextFrame } from './parse.js';
export type { ParseFailure, ParseResult } from './parse.js';

export {
  BEACON_ANNOUNCE_INTERVAL_MS,
  BEACON_EXPIRY_MS,
  BEACON_MISSED_LIMIT,
  BEACON_PORT,
  formatServerBeacon,
  parseServerBeacon,
  serverBeaconSchema,
} from './beacon.js';
export type { ServerBeacon } from './beacon.js';

export { frameIdSchema, protocolErrorFrameSchema, refusalCodeSchema } from './frames.js';
export type { FrameId, ProtocolErrorFrame, RefusalCode } from './frames.js';

export {
  hubIdSchema,
  nodeIdSchema,
  nodeKindSchema,
  providerSchema,
  serverIdSchema,
  serverRegistrationIdSchema,
  sessionIdSchema,
  sessionRefSchema,
  storeDescriptorSchema,
  storeIdSchema,
} from './identity.js';
export type {
  HubId,
  NodeId,
  NodeKind,
  Provider,
  ServerId,
  ServerRegistrationId,
  SessionId,
  SessionRef,
  StoreDescriptor,
  StoreId,
} from './identity.js';

export { layoutNodeSchema, layoutSchema } from './layout.js';
export type { Layout, LayoutNode } from './layout.js';

export {
  cpuSampleSchema,
  machineLoadSchema,
  machineStateSchema,
  serverCandidateSchema,
  serverPhaseSchema,
  serverViewSchema,
  sessionHolderSchema,
  sessionRowSchema,
  staleReasonSchema,
  storeViewSchema,
} from './machine-state.js';
export type {
  CpuSample,
  MachineLoad,
  MachineState,
  ServerCandidate,
  ServerPhase,
  ServerView,
  SessionHolder,
  SessionRow,
  StaleReason,
  StoreView,
} from './machine-state.js';

export {
  providerReadinessSchema,
  providerReadinessStateSchema,
  readinessRefusal,
} from './readiness.js';
export type { ProviderReadiness, ProviderReadinessState } from './readiness.js';

export {
  changedFileSchema,
  sessionDescriptorSchema,
  sessionHoldSchema,
  sessionStartTagSchema,
  sessionStatusSchema,
  sessionUsageSchema,
  UNCOMMITTED_FILES_LISTED,
  uncommittedDiffSchema,
} from './session.js';
export type {
  ChangedFile,
  SessionDescriptor,
  SessionHold,
  SessionStartTag,
  SessionStatus,
  SessionUsage,
  UncommittedDiff,
} from './session.js';

export {
  decodeTerminalChunk,
  encodeTerminalChunk,
  TERMINAL_CHUNK_MAX_CHARS,
  TERMINAL_INPUT_MAX_CHARS,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  terminalChunkSchema,
  terminalInputSchema,
  terminalSizeSchema,
  terminalTargetSchema,
} from './terminal.js';
export type { TerminalSize, TerminalTarget } from './terminal.js';

export {
  clientFrameSchema,
  hubFrameSchema,
  PANE_LAYOUT_MAX_CHARS,
  paneLayoutTextSchema,
  parseClientFrame,
  parseHubFrame,
} from './client.js';
export type { ClientFrame, HubFrame } from './client.js';

export {
  hubToServerFrameSchema,
  parseHubToServerFrame,
  parseServerToHubFrame,
  serverToHubFrameSchema,
} from './server.js';
export type { HubToServerFrame, ServerToHubFrame } from './server.js';
