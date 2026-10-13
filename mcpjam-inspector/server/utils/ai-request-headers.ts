import { aiRequestHeaders } from "@mcpjam/sdk";
import { resolveAppVersion } from "./log-events.js";

export function inspectorAiRequestHeaders(surface: string): Record<string, string> {
  return aiRequestHeaders(`inspector-${surface}`, resolveAppVersion() ?? "unversioned");
}
