import { readSdkVersion } from "./sdk-version.js";

/** Diagnostic attribution only; these headers never grant authorization. */
export function aiRequestHeaders(surface: string, version = readSdkVersion()): Record<string, string> {
  return { "x-mcpjam-client-version": version, "x-mcpjam-surface": surface };
}
