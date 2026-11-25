import { discoveryRunMetadata } from "@mcpjam/sdk";
import { resolveRelease } from "./log-events";

export function inspectorDiscoveryRunMetadata(setting?: boolean, nativeHarness = false) {
  return {
    ...(nativeHarness ? {} : { runUnloadedToolCalls: discoveryRunMetadata(setting).runUnloadedToolCalls }),
    engineVersion: resolveRelease() ?? "unknown",
  };
}
