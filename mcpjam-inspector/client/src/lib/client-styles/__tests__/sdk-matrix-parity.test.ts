import { describe, expect, it } from "vitest";
import {
  MCP_APPS_CHATGPT_SURFACE,
  MCP_APPS_CLAUDE_SURFACE,
  MCP_APPS_COPILOT_SURFACE,
  MCP_APPS_CURSOR_SURFACE,
  MCP_APPS_FULL_SURFACE,
  MCP_APPS_GOOSE_SURFACE,
  MCP_APPS_NO_CLAIMS_SURFACE,
  MCP_APPS_SLACK_SURFACE,
} from "../built-ins";

/**
 * The FULL / COPILOT / GOOSE / NO_CLAIMS surfaces are imported from
 * `@mcpjam/sdk/host-compat` (one source for the compat engine + this playground
 * emulation). The SDK types them sparse, so built-ins.ts casts them to the
 * client's resolved (all-required) shape. This guards that cast: if the SDK
 * ever drops a dimension, a cast would silently leave it `undefined` — these
 * assertions fail instead.
 *
 * `MCP_APPS_SLACK_SURFACE` stays a local, fully-typed resolved literal, so its
 * key set is the canonical reference.
 *
 * Deliberately coupled to the SDK's BUNDLED snapshot, not the live backend
 * catalog (CANI-2): playground emulation always runs on the constants shipped
 * in this build, so this parity guard must match those same constants.
 */
const CORE_RESOLVED_KEYS = Object.keys(MCP_APPS_SLACK_SURFACE).sort();
const OPTIONAL_EVIDENCE_KEYS = [
  "cspConnectDomains",
  "cspResourceDomains",
] as const;

const SDK_SOURCED = {
  MCP_APPS_FULL_SURFACE,
  MCP_APPS_CLAUDE_SURFACE,
  MCP_APPS_CHATGPT_SURFACE,
  MCP_APPS_COPILOT_SURFACE,
  MCP_APPS_CURSOR_SURFACE,
  MCP_APPS_GOOSE_SURFACE,
  MCP_APPS_NO_CLAIMS_SURFACE,
};

describe("SDK-sourced MCP Apps matrices are complete resolved surfaces", () => {
  for (const [name, surface] of Object.entries(SDK_SOURCED)) {
    it(`${name} defines every core resolved dimension`, () => {
      for (const key of CORE_RESOLVED_KEYS) {
        expect((surface as Record<string, unknown>)[key]).toBeDefined();
      }
      const extraKeys = Object.keys(surface).filter(
        (key) => !CORE_RESOLVED_KEYS.includes(key)
      );
      expect(
        extraKeys.every((key) => OPTIONAL_EVIDENCE_KEYS.includes(key as never))
      ).toBe(true);
    });
  }

  it("keeps subtype evidence host-specific", () => {
    expect(MCP_APPS_CLAUDE_SURFACE.cspConnectDomains).toEqual({
      fetch: true,
      xhr: true,
      websocket: true,
    });
    // `connect-src` is one directive, so ChatGPT's three subtypes cannot
    // diverge: the declared wss endpoint connected while an undeclared one
    // took a real violation, so the declared list is honored throughout.
    expect(MCP_APPS_CHATGPT_SURFACE.cspConnectDomains).toEqual({
      fetch: true,
      xhr: true,
      websocket: true,
    });
    // Measured true since the 2026-08-23 paired probe: it declared
    // `fastly.jsdelivr.net`, an origin OUTSIDE ChatGPT's baseline allowlist,
    // and every declared resource subtype loaded — which is what separates
    // honored from ignored, and is why this is no longer "unknown".
    expect(MCP_APPS_CHATGPT_SURFACE.cspResourceDomains).toEqual({
      script: true,
      stylesheet: true,
      image: true,
      font: true,
      media: true,
    });
    expect(MCP_APPS_CURSOR_SURFACE.cspResourceDomains?.media).toBe(true);
    expect(MCP_APPS_GOOSE_SURFACE.cspConnectDomains).toEqual({
      fetch: false,
      xhr: false,
      websocket: false,
    });
    expect(MCP_APPS_FULL_SURFACE.cspConnectDomains).toBeUndefined();
  });
});
