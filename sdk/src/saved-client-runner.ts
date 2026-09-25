import { PlatformApiClient } from "./platform/client.js";
import type { MCPClientManager } from "./mcp-client-manager/MCPClientManager.js";
import { HostRunner } from "./HostRunner.js";
import { canonicalizeHostConfigV2 } from "./host-config/canonicalize.js";
import { canonicalToPublic } from "./host-config/host.js";
import type { HostConfigInputV2 } from "./host-config/types.js";
import {
  assertModelSelection,
  type ModelSelectionSource,
} from "./host-config/model-selection.js";
import type { SelectedEvalClient } from "./eval-reporting-types.js";

export interface EvalSuiteClientOptions {
  /**
   * Saved client name or ID. The latest version is read once per run.
   *
   * Pass several to run the suite against each of them in parallel. Each
   * client uploads its own run, and the runs share one run group in MCPJam.
   */
  client: string | readonly string[];
  projectId: string;
  apiKey: string;
  /** Servers and their connections are owned by the test code. */
  manager: MCPClientManager;
  /** MCPJam app origin, for example https://app.mcpjam.com. */
  baseUrl?: string;
}

/** Also bounds setup operations that do not themselves accept a signal. */
export async function abortableSetup<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("Test run cancelled"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Thrown when a saved client's `modelSelection` names credentials
 * `runWithClient` cannot use. The runner only has the hosted MCPJam rail (the
 * caller's MCPJam API key), so an `org` or `local` selection is refused rather
 * than silently run on MCPJam's key as a bare model id.
 */
export class UnsupportedModelSelectionError extends Error {
  readonly source: Exclude<ModelSelectionSource, "hosted">;
  readonly modelId: string;

  constructor(
    source: Exclude<ModelSelectionSource, "hosted">,
    modelId: string
  ) {
    super(
      `runWithClient only runs hosted MCPJam models; this client's model selection "${modelId}" uses source "${source}" (${
        source === "org"
          ? "an organization provider connection"
          : "a local provider"
      }), which it cannot honour. Run this client from MCPJam, or save it with a hosted model.`
    );
    this.name = "UnsupportedModelSelectionError";
    this.source = source;
    this.modelId = modelId;
  }
}

/** One saved client — what a single run resolves. */
export type EvalSuiteSingleClientOptions = Omit<
  EvalSuiteClientOptions,
  "client"
> & { client: string };

export async function createSavedClientRunner(
  input: EvalSuiteSingleClientOptions,
  signal: AbortSignal
): Promise<{ executor: HostRunner; selectedClient: SelectedEvalClient }> {
  const api = new PlatformApiClient({
    getAuth: () => input.apiKey,
    ...(input.baseUrl
      ? { baseUrl: `${input.baseUrl.replace(/\/$/, "")}/api/v1` }
      : {}),
  });
  const client = await abortableSetup(
    api.getClient(
      { projectId: input.projectId, client: input.client },
      { signal }
    ),
    signal
  );
  signal.throwIfAborted();
  if (
    !client.configId ||
    !client.versionId ||
    !Number.isSafeInteger(client.versionNumber) ||
    client.versionNumber! < 1
  ) {
    throw new Error(
      "This client has no recorded version. Update the MCPJam backend and save the client before running SDK tests."
    );
  }
  const config = structuredClone(client.config);
  if (
    config.computer ||
    config.browserProfileId ||
    (config.harness && config.harness !== "emulated") ||
    (Array.isArray(config.builtInToolIds) && config.builtInToolIds.length) ||
    (config.skillSelection as { skillIds?: unknown[] } | undefined)?.skillIds
      ?.length ||
    config.progressiveToolDiscovery ||
    config.requireToolApproval
  ) {
    throw new Error(
      "This client requires a runtime feature unsupported by runWithClient (computer/browser, built-in tools, saved skills, progressive discovery, or interactive approval). Use a client configured for code-connected MCP servers."
    );
  }
  // The saved selection says whose credentials serve the model. This runner
  // only has the hosted MCPJam rail, so anything else is refused here — never
  // downgraded to the bare id (which would run on MCPJam's key). A hosted
  // selection runs exactly as a bare id did. The selection is then dropped:
  // the id below is rewritten to its `mcpjam/` form, which a selection would
  // (correctly) refuse to agree with.
  const savedSelection = (config as { modelSelection?: unknown })
    .modelSelection;
  delete (config as { modelSelection?: unknown }).modelSelection;
  if (savedSelection !== undefined) {
    const selection = assertModelSelection(
      savedSelection,
      "client modelSelection"
    );
    if (selection.source !== "hosted") {
      throw new UnsupportedModelSelectionError(
        selection.source,
        selection.modelId
      );
    }
  }
  let model = String(config.modelId ?? "").replace(/^mcpjam\//, "");
  if (!model.includes("/")) {
    if (model.startsWith("claude-")) model = `anthropic/${model}`;
    else if (model.startsWith("gpt-5")) model = `openai/${model}`;
  }
  if (!/^(anthropic\/claude-|openai\/gpt-5)/.test(model)) {
    throw new Error(
      `runWithClient supports MCPJam Claude and GPT-5 models; client model "${model}" is unsupported.`
    );
  }
  // Connection policy belongs to the code's already-connected manager. Saved
  // server IDs and connection overrides must not be replayed against local IDs.
  const serverIds = [...input.manager.listServers()];
  for (const id of serverIds) {
    if (input.manager.getConnectionStatus(id) !== "connected") {
      throw new Error(
        `Connect MCP server "${id}" before calling runWithClient.`
      );
    }
  }
  const host = canonicalToPublic(
    canonicalizeHostConfigV2({
      ...config,
      modelId: `mcpjam/${model}`,
      // Local browser availability is a UI preference, not a runtime requirement.
      localBrowserEnabled: false,
      serverIds,
      optionalServerIds: [],
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
      clientCapabilities: {},
      mcpProfile: (config.mcpProfile as { apps?: unknown } | undefined)?.apps
        ? {
            profileVersion: 1,
            apps: (config.mcpProfile as { apps: unknown }).apps,
          }
        : undefined,
      serverConnectionOverrides: undefined,
    } as unknown as HostConfigInputV2)
  );
  const tools = await abortableSetup(
    input.manager.getToolsForAiSdk(host.servers, {
      includeAppOnly: host.respectToolVisibility === false,
      modelVisibleMcpToolResults: host.modelVisibleMcpToolResults,
    }),
    signal
  );
  signal.throwIfAborted();
  return {
    executor: new HostRunner({
      host,
      systemPrompt: host.systemPrompt,
      temperature: host.temperature,
      tools,
      apiKey: input.apiKey,
      mcpClientManager: input.manager,
      mcpjamProject: input.projectId,
      baseUrls: input.baseUrl ? { mcpjam: input.baseUrl } : undefined,
    }),
    selectedClient: {
      id: client.id,
      name: client.name,
      configId: client.configId,
      versionId: client.versionId,
      versionNumber: client.versionNumber!,
    },
  };
}
