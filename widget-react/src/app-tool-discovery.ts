import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  appToolSourceFor,
  discoverViewAppTools,
  listViewWebmcpTools,
  type AppToolSource,
} from "@mcpjam/sdk/widget-runtime";
import type {
  AppInstance,
  AppToolDescriptor,
  AppToolsRegistryState,
} from "./app-tools-registry";

export interface AppToolDiscoveryOptions {
  force?: boolean;
  surface?: "inline" | "modal";
  getIframeElement?: () => HTMLIFrameElement | null;
  isLive: () => boolean;
}

interface DiscoveryState {
  source: AppToolSource;
  attempted: boolean;
  listed: boolean;
  dirty: boolean;
  pending?: Promise<void>;
}

/** One source and one refresh loop per bridge, shared by inline and modal views. */
export function createAppToolDiscovery(config: {
  registry: { getState: () => AppToolsRegistryState };
  context: () => Pick<
    AppInstance,
    "chatSessionId" | "parentToolCallId" | "serverId"
  >;
  onError: (error: unknown) => void;
}) {
  const states = new WeakMap<AppBridge, DiscoveryState>();
  return function refresh(
    bridge: AppBridge,
    bridgeId: string,
    options: AppToolDiscoveryOptions,
  ): Promise<void> {
    let state = states.get(bridge);
    if (!state) {
      state = {
        source: appToolSourceFor(bridge.getAppCapabilities()),
        attempted: false,
        listed: false,
        dirty: false,
      };
      states.set(bridge, state);
    }
    if (state.pending) {
      if (options.force) state.dirty = true;
      return state.pending;
    }
    if (state.listed && !options.force) return Promise.resolve();
    const current = state;
    const legacy = async () => {
      const tools: AppToolDescriptor[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 8; page++) {
        const result = await bridge.listTools(
          cursor === undefined ? {} : { cursor },
        );
        tools.push(
          ...(result.tools ?? []).filter((tool) =>
            Boolean(
              tool && typeof tool.name === "string" && tool.name.length > 0,
            ),
          ),
        );
        cursor =
          typeof result.nextCursor === "string" ? result.nextCursor : undefined;
        if (cursor === undefined) break;
        if (page === 7)
          console.warn(
            `[MCP Apps] tools/list still had more pages after 8; registering a partial tool set for bridge ${bridgeId}.`,
          );
      }
      return tools;
    };
    current.pending = (async () => {
      try {
        do {
          current.dirty = false;
          if (!options.isLive()) return;
          const initial = !current.attempted;
          current.attempted = true;
          const result = initial
            ? await discoverViewAppTools(bridge, current.source, true, legacy)
            : {
                source: current.source,
                tools:
                  current.source === "webmcp"
                    ? await listViewWebmcpTools(bridge)
                    : await legacy(),
              };
          current.source = result.source;
          current.listed = true;
          if (!options.isLive()) return;
          if (result.source === "webmcp" && result.tools.length === 0) {
            config.registry.getState().unregisterInstance(bridgeId);
          } else {
            const context = config.context();
            const version = bridge.getAppVersion();
            await config.registry.getState().registerInstance({
              ...context,
              bridgeId,
              bridge,
              tools: result.tools,
              toolSource: result.source,
              appName: version?.name ?? context.serverId,
              appVersion: version?.version,
              surface: options.surface ?? "inline",
              registeredAtMs: Date.now(),
              getIframeElement: options.getIframeElement,
            });
            if (!options.isLive())
              config.registry.getState().unregisterInstance(bridgeId);
          }
        } while (current.dirty && options.isLive());
      } catch (error) {
        current.listed = false;
        if (current.source === "webmcp" && options.isLive()) {
          config.registry.getState().unregisterInstance(bridgeId);
        }
        if (options.isLive()) config.onError(error);
      } finally {
        current.pending = undefined;
      }
    })();
    return current.pending;
  };
}
