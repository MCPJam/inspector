import { cursorModelRows } from "../cursor-models";
import { describe, expect, it } from "vitest";
import type { HostDetail } from "@/hooks/useClients";
import type { ComparePaneEnvironment } from "@/hooks/use-compare-environment-panes";
import type { EnvironmentPreview } from "@/hooks/use-environment-preview";
import type { ModelDefinition } from "@/shared/types";
import { resolveEnvironmentPaneColumn } from "../compare-environment-columns";

const catalog: ModelDefinition[] = ["openai/gpt-5.5", "openai/gpt-5-mini"].map(
  (id) => ({
    id,
    name: id,
    provider: "openai" as ModelDefinition["provider"],
    hosted: true,
  }),
);

function client(hostId: string, harness?: string): HostDetail {
  return {
    hostId,
    name: hostId,
    config: {
      schemaVersion: 2,
      hostStyle: "chatgpt",
      ...(harness ? { harness } : {}),
      // The client's own model, which an environment pane never falls back to.
      modelId: "openai/gpt-5.5",
      systemPrompt: "Client prompt",
      temperature: 0,
      requireToolApproval: false,
      serverIds: [],
      optionalServerIds: [],
      clientCapabilities: {},
      hostContext: {},
      connectionDefaults: { headers: {}, requestTimeout: 30000 },
    } as HostDetail["config"],
  };
}

function preview(modelId: string | null): EnvironmentPreview {
  return {
    specVersion: 1,
    environment: { environmentId: "env_1", name: "E1", revision: 2 },
    host: {
      hostId: "h-1",
      hostName: "Claude Code",
      hostConfigId: "cfg",
      modelId,
      hostStyle: null,
      harness: null,
    },
    servers: [],
    skills: [],
    plugins: [],
    capabilities: {
      requireToolApproval: null,
      respectToolVisibility: null,
      progressiveToolDiscovery: null,
      builtInToolIds: [],
      hasComputer: false,
      serverCount: 0,
      skillCount: 0,
      skillDelivery: "emulated",
      pluginCount: 0,
      serversOverridden: false,
    },
  };
}

function resolve(
  environment: Partial<ComparePaneEnvironment>,
  options: {
    host?: HostDetail | null;
    hostLoading?: boolean;
    models?: ModelDefinition[];
    pickedSelection?: Parameters<
      typeof resolveEnvironmentPaneColumn
    >[0]["pickedSelection"];
  } = {},
) {
  return resolveEnvironmentPaneColumn({
    index: 0,
    paneId: "pane-1",
    environment: {
      environmentId: "env_1",
      visible: true,
      preview: preview("openai/gpt-5-mini"),
      isLoading: false,
      error: null,
      ...environment,
    },
    slot: {
      host: options.host === undefined ? client("h-1") : options.host,
      isLoading: options.hostLoading ?? false,
    },
    hosts: [{ hostId: "h-1", name: "Claude Code" } as never],
    models: options.models ?? catalog,
    pickedSelection: options.pickedSelection,
  });
}

describe("resolveEnvironmentPaneColumn", () => {
  it("shows the environment's model without sending it, on the environment's client", () => {
    const result = resolve({});
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.column).toMatchObject({
      compareId: "pane-1",
      hostId: "h-1",
      targetKey: "environment:env_1",
      environmentId: "env_1",
      compareLabel: "E1",
      selection: undefined,
      modelPicked: false,
      inheritedEnvironmentModel: { modelId: "openai/gpt-5-mini" },
    });
    // The environment's model, not the client's own `openai/gpt-5.5`.
    expect(result.column.model.id).toBe("openai/gpt-5-mini");
  });

  it("sends a model picked in the pane, and stops inheriting", () => {
    const pickedSelection = {
      source: "hosted" as const,
      modelId: "openai/gpt-5.5",
      fallback: { provider: "none" as const, model: "none" as const },
    };
    const result = resolve({}, { pickedSelection });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.column.selection).toEqual(pickedSelection);
    expect(result.column.modelPicked).toBe(true);
    expect(result.column.model.id).toBe("openai/gpt-5.5");
    expect(result.column.inheritedEnvironmentModel).toBeUndefined();
  });

  it("resolves a Cursor environment model and a pane override from its account catalog", () => {
    const models = cursorModelRows({
      configured: true,
      models: [{ modelId: "cursor/mini", displayName: "Mini" }],
    });
    const result = resolve(
      { preview: preview("cursor/auto") },
      {
        host: client("h-1", "cursor"),
        models,
        pickedSelection: { source: "legacy", modelId: "cursor/mini" },
      },
    );
    expect(result).toMatchObject({
      status: "ready",
      column: {
        model: { id: "cursor/mini" },
        selection: { source: "legacy", modelId: "cursor/mini" },
      },
    });
  });

  it("waits for the environment and its client, and blocks while they load", () => {
    expect(resolve({ isLoading: true, preview: null }).status).toBe("loading");
    const hostLoading = resolve({}, { host: null, hostLoading: true });
    expect(hostLoading).toMatchObject({
      status: "loading",
      reason: "Loading client…",
    });
  });

  it("blocks with the environment's error rather than running its client", () => {
    const result = resolve({
      preview: null,
      error: {
        message: "This environment was archived.",
        code: "ENV_ARCHIVED",
      },
    });
    expect(result.status).toBe("unavailable");
    expect(result.status !== "ready" && result.reason).toBe(
      "This environment was archived.",
    );
  });

  it("blocks when the environment's client is gone, naming it", () => {
    expect(resolve({}, { host: null })).toMatchObject({
      status: "unavailable",
      reason:
        "Claude Code is unavailable. Choose another client or environment in pane settings.",
    });
  });

  it("blocks when the environment's model cannot run", () => {
    expect(resolve({ preview: preview("openai/retired") })).toMatchObject({
      status: "unavailable",
      reason:
        "This pane's model is unavailable. Choose another in pane settings.",
    });
  });
});
