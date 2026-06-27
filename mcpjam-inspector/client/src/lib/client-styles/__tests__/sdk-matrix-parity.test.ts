import { describe, expect, it } from "vitest";
import {
  MCP_APPS_COPILOT_SURFACE,
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
 */
const RESOLVED_KEYS = Object.keys(MCP_APPS_SLACK_SURFACE).sort();

const SDK_SOURCED = {
  MCP_APPS_FULL_SURFACE,
  MCP_APPS_COPILOT_SURFACE,
  MCP_APPS_GOOSE_SURFACE,
  MCP_APPS_NO_CLAIMS_SURFACE,
};

describe("SDK-sourced MCP Apps matrices are complete resolved surfaces", () => {
  for (const [name, surface] of Object.entries(SDK_SOURCED)) {
    it(`${name} defines exactly the resolved dimensions (no SDK drift)`, () => {
      expect(Object.keys(surface).sort()).toEqual(RESOLVED_KEYS);
      for (const key of RESOLVED_KEYS) {
        expect((surface as Record<string, unknown>)[key]).toBeDefined();
      }
    });
  }
});
