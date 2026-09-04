import type { ClientAnalyticsEventName } from "@/shared/analytics-events";
import { stableStringifyJson } from "@/lib/client-config";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";

export const CLIENT_SETTING_IDS = [
  "client.name",
  "client.profile",
  "model",
  "system_prompt",
  "temperature",
  "tool_approval",
  "tool_visibility",
  "progressive_tool_discovery",
  "model_visible_tool_results",
  "tool_result_image_rendering",
  "servers",
  "optional_servers",
  "built_in_tools",
  "computer",
  "harness",
  "connection.headers",
  "connection.request_timeout",
  "client_capabilities",
  "host_context",
  "host_capabilities",
  "appearance",
  "mcp.protocol_version",
  "mcp.tool_param_header_mirroring",
  "mcp.pagination_traversal",
  "mcp.mrtr_support",
  "mcp.tool_call_cancellation.legacy",
  "mcp.tool_call_cancellation.modern",
  "mcp.tool_list_changed.listens",
  "mcp.tool_list_changed.refetches",
  "mcp.initialize.supported_protocol_versions",
  "mcp.initialize.client_info",
  "mcp.apps.sandbox.csp",
  "mcp.apps.sandbox.permissions",
  "mcp.apps.sandbox.browser_storage.local_storage",
  "mcp.apps.sandbox.browser_storage.session_storage",
  "mcp.apps.sandbox.browser_storage.indexed_db",
  "mcp.apps.sandbox.attributes",
  "mcp.apps.sandbox.allowed_features",
  "mcp.apps.ui_initialize.host_info",
  "mcp.apps.compat_runtime",
  "mcp.apps.capabilities",
  "mcp.extensions",
  "server_connection.headers",
  "server_connection.request_timeout",
  "server_connection.protocol_version",
] as const;

export type ClientSettingId = (typeof CLIENT_SETTING_IDS)[number];

type SettingDetector = (
  saved: HostConfigInputV2,
  draft: HostConfigInputV2,
) => readonly ClientSettingId[];

const equal = (left: unknown, right: unknown): boolean =>
  stableStringifyJson(left) === stableStringifyJson(right);

const one =
  (
    id: ClientSettingId,
    select: (config: HostConfigInputV2) => unknown,
  ): SettingDetector =>
  (saved, draft) =>
    equal(select(saved), select(draft)) ? [] : [id];

const mcpProfileChanges: SettingDetector = (saved, draft) => {
  const before = saved.mcpProfile;
  const after = draft.mcpProfile;
  const pairs: ReadonlyArray<readonly [ClientSettingId, unknown, unknown]> = [
    [
      "mcp.protocol_version",
      before?.mcpProtocolVersion,
      after?.mcpProtocolVersion,
    ],
    [
      "mcp.tool_param_header_mirroring",
      before?.toolParamHeaderMirroring,
      after?.toolParamHeaderMirroring,
    ],
    [
      "mcp.pagination_traversal",
      before?.paginationTraversal,
      after?.paginationTraversal,
    ],
    ["mcp.mrtr_support", before?.mrtrSupport, after?.mrtrSupport],
    [
      "mcp.tool_call_cancellation.legacy",
      before?.toolCallCancellation?.legacy,
      after?.toolCallCancellation?.legacy,
    ],
    [
      "mcp.tool_call_cancellation.modern",
      before?.toolCallCancellation?.modern,
      after?.toolCallCancellation?.modern,
    ],
    [
      "mcp.tool_list_changed.listens",
      before?.toolListChanged?.listens,
      after?.toolListChanged?.listens,
    ],
    [
      "mcp.tool_list_changed.refetches",
      before?.toolListChanged?.refetches,
      after?.toolListChanged?.refetches,
    ],
    [
      "mcp.initialize.supported_protocol_versions",
      before?.initialize?.supportedProtocolVersions,
      after?.initialize?.supportedProtocolVersions,
    ],
    [
      "mcp.initialize.client_info",
      before?.initialize?.clientInfo,
      after?.initialize?.clientInfo,
    ],
    [
      "mcp.apps.sandbox.csp",
      before?.apps?.sandbox?.csp,
      after?.apps?.sandbox?.csp,
    ],
    [
      "mcp.apps.sandbox.permissions",
      before?.apps?.sandbox?.permissions,
      after?.apps?.sandbox?.permissions,
    ],
    [
      "mcp.apps.sandbox.browser_storage.local_storage",
      before?.apps?.sandbox?.browserStorage?.localStorage,
      after?.apps?.sandbox?.browserStorage?.localStorage,
    ],
    [
      "mcp.apps.sandbox.browser_storage.session_storage",
      before?.apps?.sandbox?.browserStorage?.sessionStorage,
      after?.apps?.sandbox?.browserStorage?.sessionStorage,
    ],
    [
      "mcp.apps.sandbox.browser_storage.indexed_db",
      before?.apps?.sandbox?.browserStorage?.indexedDB,
      after?.apps?.sandbox?.browserStorage?.indexedDB,
    ],
    [
      "mcp.apps.sandbox.attributes",
      before?.apps?.sandbox?.sandboxAttrs,
      after?.apps?.sandbox?.sandboxAttrs,
    ],
    [
      "mcp.apps.sandbox.allowed_features",
      before?.apps?.sandbox?.allowFeatures,
      after?.apps?.sandbox?.allowFeatures,
    ],
    [
      "mcp.apps.ui_initialize.host_info",
      before?.apps?.uiInitialize?.hostInfo,
      after?.apps?.uiInitialize?.hostInfo,
    ],
    [
      "mcp.apps.compat_runtime",
      before?.apps?.compatRuntime,
      after?.apps?.compatRuntime,
    ],
    [
      "mcp.apps.capabilities",
      before?.apps?.mcpAppsOverrides,
      after?.apps?.mcpAppsOverrides,
    ],
    ["mcp.extensions", before?.extensions, after?.extensions],
  ];

  return pairs
    .filter(([, left, right]) => !equal(left, right))
    .map(([id]) => id);
};

type ServerOverride = NonNullable<
  HostConfigInputV2["serverConnectionOverrides"]
>[string];

const projectServerOverrides = (
  config: HostConfigInputV2,
  key: keyof ServerOverride,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(config.serverConnectionOverrides ?? {}).map(
      ([serverId, value]) => [serverId, value[key]],
    ),
  );

const serverOverrideChanges: SettingDetector = (saved, draft) => {
  const pairs: ReadonlyArray<readonly [ClientSettingId, keyof ServerOverride]> =
    [
      ["server_connection.headers", "headersOverride"],
      ["server_connection.request_timeout", "requestTimeoutOverride"],
      ["server_connection.protocol_version", "mcpProtocolVersionOverride"],
    ];
  return pairs
    .filter(
      ([, key]) =>
        !equal(
          projectServerOverrides(saved, key),
          projectServerOverrides(draft, key),
        ),
    )
    .map(([id]) => id);
};

/**
 * Exhaustive at the HostConfigInputV2 boundary. Adding a new top-level client
 * setting is a type error until its privacy-safe telemetry detector is chosen.
 */
const CLIENT_SETTING_DETECTORS = {
  hostStyle: one("client.profile", (config) => config.hostStyle),
  modelId: one("model", (config) => config.modelId),
  systemPrompt: one("system_prompt", (config) => config.systemPrompt),
  temperature: one("temperature", (config) => config.temperature),
  requireToolApproval: one(
    "tool_approval",
    (config) => config.requireToolApproval,
  ),
  respectToolVisibility: one(
    "tool_visibility",
    (config) => config.respectToolVisibility,
  ),
  progressiveToolDiscovery: one(
    "progressive_tool_discovery",
    (config) => config.progressiveToolDiscovery,
  ),
  modelVisibleMcpToolResults: one(
    "model_visible_tool_results",
    (config) => config.modelVisibleMcpToolResults,
  ),
  mcpToolResultImageRendering: one(
    "tool_result_image_rendering",
    (config) => config.mcpToolResultImageRendering,
  ),
  serverIds: one("servers", (config) => config.serverIds),
  optionalServerIds: one(
    "optional_servers",
    (config) => config.optionalServerIds,
  ),
  builtInToolIds: one("built_in_tools", (config) => config.builtInToolIds),
  computer: one("computer", (config) => config.computer),
  harness: one("harness", (config) => config.harness),
  connectionDefaults: (saved, draft) => [
    ...(equal(
      saved.connectionDefaults.headers,
      draft.connectionDefaults.headers,
    )
      ? []
      : (["connection.headers"] as const)),
    ...(equal(
      saved.connectionDefaults.requestTimeout,
      draft.connectionDefaults.requestTimeout,
    )
      ? []
      : (["connection.request_timeout"] as const)),
  ],
  clientCapabilities: one(
    "client_capabilities",
    (config) => config.clientCapabilities,
  ),
  hostContext: one("host_context", (config) => config.hostContext),
  hostCapabilitiesOverride: one(
    "host_capabilities",
    (config) => config.hostCapabilitiesOverride,
  ),
  chatUiOverride: one("appearance", (config) => config.chatUiOverride),
  mcpProfile: mcpProfileChanges,
  serverConnectionOverrides: serverOverrideChanges,
} satisfies Record<keyof HostConfigInputV2, SettingDetector>;

export function changedClientSettings(input: {
  savedName: string;
  draftName: string;
  savedConfig: HostConfigInputV2;
  draftConfig: HostConfigInputV2;
}): ClientSettingId[] {
  const changed: ClientSettingId[] =
    input.savedName === input.draftName ? [] : ["client.name" as const];
  for (const detector of Object.values(CLIENT_SETTING_DETECTORS)) {
    changed.push(...detector(input.savedConfig, input.draftConfig));
  }
  return changed;
}

type Capture = (
  event: ClientAnalyticsEventName,
  props: Record<string, unknown>,
) => void;

export function emitClientSaveTelemetry(
  capture: Capture,
  input: {
    clientId: string;
    clientConfigId: string;
    savedName: string;
    draftName: string;
    savedConfig: HostConfigInputV2;
    draftConfig: HostConfigInputV2;
  },
): void {
  const changedFields = (
    Object.keys(input.draftConfig) as Array<keyof HostConfigInputV2>
  ).filter((key) => !equal(input.draftConfig[key], input.savedConfig[key]));
  const settings = changedClientSettings(input);
  const common = {
    location: "client_builder",
    client_id: input.clientId,
    client_config_id: input.clientConfigId,
  };

  try {
    capture("client_config_saved", {
      ...common,
      server_count: input.draftConfig.serverIds?.length ?? 0,
      changed_fields: changedFields,
    });
  } catch {
    // Analytics is best-effort and must never affect a successful save.
  }

  for (const setting of settings) {
    try {
      capture("client_setting_saved", { ...common, setting });
    } catch {
      // One failed capture must not stop the save or the remaining events.
    }
  }
}
