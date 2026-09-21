export { PROTOCOL_VERSION, checkProtocolVersion } from './version.js';
export type { ProtocolVersionMismatch } from './version.js';

export { frameParser, parseTextFrame } from './parse.js';
export { assertNever } from './exhaustive.js';
export type { ParseFailure, ParseResult } from './parse.js';

export {
  CATALOGUE_FILTER_MAX_KINDS,
  CATALOGUE_PAGE_MAX_LIMIT,
  CATALOGUE_SEARCH_MAX_CHARS,
  catalogueCursorSchema,
  catalogueFilterSchema,
  catalogueGroupBySchema,
  catalogueGroupSchema,
  catalogueItemSchema,
  catalogueMatchFieldSchema,
  catalogueNameSourceSchema,
  catalogueQuerySchema,
  catalogueSortKeySchema,
  catalogueSortSchema,
  catalogueViewSchema,
  sortDirectionSchema,
} from './catalogue.js';
export type {
  CatalogueFilter,
  CatalogueGroup,
  CatalogueGroupBy,
  CatalogueItem,
  CatalogueMatchField,
  CatalogueNameSource,
  CatalogueQuery,
  CatalogueSort,
  CatalogueSortKey,
  CatalogueView,
  SortDirection,
} from './catalogue.js';

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

export {
  DIRECTORY_ENTRIES_MAX,
  directoryEntryKindSchema,
  directoryEntrySchema,
  directoryListFrameSchema,
  directoryListingFrameSchema,
  directorySchema,
  normaliseDirectory,
} from './directory.js';
export type { DirectoryEntry, DirectoryEntryKind, DirectoryListingFrame } from './directory.js';

export {
  DOC_CONTENT_MAX_CHARS,
  DOC_NAME_EXTENSIONS,
  DOC_NAME_MAX_LENGTH,
  docContentSchema,
  docDirectorySchema,
  docEntrySchema,
  docNameSchema,
} from './doc.js';
export type { DocEntry, DocName } from './doc.js';

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
  startIdSchema,
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
  StartId,
  StoreDescriptor,
  StoreId,
} from './identity.js';

export {
  loopbackServerAddress,
  pairedServerAddressSchema,
  serverAddressSchema,
  serverLabelSchema,
  serverTokenSchema,
  SERVER_LABEL_MAX_CHARS,
} from './pairing.js';
export type { ServerAddress } from './pairing.js';

export {
  layoutNodeSchema,
  layoutSchema,
  NODE_NAME_MAX_CHARS,
  nodeNameTextSchema,
} from './layout.js';
export type { Layout, LayoutNode } from './layout.js';

export {
  cpuSampleSchema,
  machineLoadSchema,
  machineStateSchema,
  serverCandidateSchema,
  serverDrainingSchema,
  serverPhaseSchema,
  serverViewSchema,
  sessionHolderSchema,
  sessionProjectSchema,
  sessionRowSchema,
  staleReasonSchema,
  storeViewSchema,
} from './machine-state.js';
export type {
  CpuSample,
  MachineLoad,
  MachineState,
  ServerCandidate,
  ServerDraining,
  ServerPhase,
  ServerView,
  SessionHolder,
  SessionProject,
  SessionRow,
  StaleReason,
  StoreView,
} from './machine-state.js';

export {
  providerReadinessSchema,
  providerReadinessStateSchema,
  readinessRefusal,
  sameReadiness,
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
  clientTerminalTargetSchema,
  decodeTerminalChunk,
  encodeTerminalChunk,
  serverTerminalTargetSchema,
  subscriptionEndedFrameSchema,
  subscriptionEndReasonSchema,
  TERMINAL_CHUNK_MAX_CHARS,
  TERMINAL_INPUT_MAX_CHARS,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  terminalChunkSchema,
  terminalInputSchema,
  terminalSizeSchema,
} from './terminal.js';
export type {
  ClientTerminalTarget,
  ServerTerminalTarget,
  SubscriptionEndReason,
  TerminalSize,
} from './terminal.js';

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
