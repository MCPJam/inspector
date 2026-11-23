import { readSdkVersion } from "./sdk-version.js";

/**
 * The User-Agent MCPJam sends to MCP servers and their OAuth servers.
 *
 * `MCP-Inspector/1.0` stays at the end because it used to be the whole value,
 * and a server may have allowlisted it.
 */
export function mcpjamUserAgent(version: string): string {
  return `MCPJam/${version} (+https://mcpjam.com) MCP-Inspector/1.0`;
}

/**
 * The default lives on `globalThis`, not in this module. The SDK builds every
 * entry with its own copy of shared code (`splitting: false`), so a module
 * variable set through `@mcpjam/sdk` would never reach the copy inside
 * `@mcpjam/sdk/oauth/node`, which is where the hosted MCP transport lives.
 */
const DEFAULT_USER_AGENT_SLOT = Symbol.for("mcpjam.defaultUserAgent");

/** The User-Agent to send when the caller set none. Read it per request. */
export function getDefaultUserAgent(): string {
  const value: unknown = Reflect.get(globalThis, DEFAULT_USER_AGENT_SLOT);
  return typeof value === "string" ? value : mcpjamUserAgent(readSdkVersion());
}

/** Lets an app put its own version in the value. Call it once at startup. */
export function setDefaultUserAgent(value: string): void {
  Reflect.set(globalThis, DEFAULT_USER_AGENT_SLOT, value);
}
