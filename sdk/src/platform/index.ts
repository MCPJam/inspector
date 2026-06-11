/**
 * `@mcpjam/sdk/platform` — fetch-based client and curated operation catalog
 * for the MCPJam Platform API (`/api/v1`).
 *
 * Runtime-agnostic by construction: native fetch only, no Node built-ins, no
 * ambient environment reads (enforced by the repo-root
 * `check:platform-runtime-safety` guard). Consumed by the MCP worker
 * (Cloudflare), the CLI, and SDK users.
 */
export {
  PLATFORM_V1_ERROR_CODES,
  PlatformApiError,
  isPlatformApiError,
  type PlatformApiErrorCode,
  type PlatformApiErrorOptions,
  type PlatformV1ErrorCode,
} from "./errors.js";

export {
  DEFAULT_PLATFORM_API_BASE_URL,
  PlatformApiClient,
  type PlatformApiClientOptions,
} from "./client.js";

export type {
  PlatformChatbox,
  PlatformChatboxDetail,
  PlatformChatboxLink,
  PlatformChatboxServer,
  PlatformChatSession,
  PlatformDoctorReport,
  PlatformEvalIteration,
  PlatformEvalRun,
  PlatformEvalRunCreated,
  PlatformEvalRunSummary,
  PlatformEvalSuite,
  PlatformMe,
  PlatformPage,
  PlatformProject,
  PlatformProjectServer,
} from "./types.js";

export {
  SHOW_SERVERS_DOCTOR_CONCURRENCY,
  buildShowServersPayload,
  projectResolutionError,
  resolveProject,
  type BuildShowServersPayloadInput,
  type ProjectInfo,
  type ProjectResolution,
  type SelectedProjectInfo,
  type ServerEntry,
  type ServerInfo,
  type ServerPrimitiveCollection,
  type ServerPrimitiveListStatus,
  type ServerPrimitives,
  type ServerPromptArgumentInfo,
  type ServerPromptInfo,
  type ServerResourceInfo,
  type ServerStatus,
  type ServerToolInfo,
  type ServerTransportType,
  type ShowServersDoctorFn,
  type ShowServersPayload,
  type ShowServersSummary,
} from "./show-servers.js";

export {
  getChatboxOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  listChatboxesOperation,
  listChatSessionsOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listProjectsOperation,
  listProjectServersOperation,
  runEvalSuiteOperation,
  showServersOperation,
  type EvalRunScopedInput,
  type GetChatboxInput,
  type GetChatboxResult,
  type GetEvalIterationTraceInput,
  type GetEvalIterationTraceResult,
  type GetEvalRunResult,
  type ListChatboxesResult,
  type ListChatSessionsInput,
  type ListChatSessionsResult,
  type ListEvalRunIterationsInput,
  type ListEvalRunIterationsResult,
  type ListEvalSuiteRunsInput,
  type ListEvalSuiteRunsResult,
  type ListEvalSuitesResult,
  type ListProjectServersResult,
  type ListProjectsInput,
  type PlatformOperation,
  type PlatformOperationContext,
  type ProjectScopedInput,
  type RunEvalSuiteInput,
  type RunEvalSuiteResult,
} from "./operations.js";
