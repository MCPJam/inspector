/**
 * Generate the HostConfig v2 golden-vector parity fixture.
 *
 * Runs a curated battery of inputs through the BUILT SDK canonicalizer + hash
 * and writes `tests/fixtures/host-config-parity-fixtures.json`. The backend
 * keeps a BYTE-IDENTICAL copy at
 * `mcpjam-backend/tests/convex/fixtures/host-config-parity-fixtures.json` and
 * asserts its own canonicalizer reproduces the same canonical JSON + sha256.
 *
 * Regenerate (and copy to the backend) whenever the canonicalizer changes:
 *   npm run build && node scripts/gen-host-config-parity-fixture.mjs
 *
 * The top-level `__inputHash` pins the sha256 of the rows array so a partial
 * edit to one repo's copy fails that repo's parity test loudly.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeHostConfigV2,
  computeHostConfigHashV2,
  sha256Hex,
} from "../dist/host-config/internal.js";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "tests", "fixtures", "host-config-parity-fixtures.json");

/** Minimal valid base; spread + override per vector. */
const base = () => ({
  hostStyle: "claude",
  modelId: "anthropic/claude-sonnet-4-6",
  systemPrompt: "You are a helpful assistant.",
  temperature: 0.7,
  requireToolApproval: false,
  connectionDefaults: { headers: {}, requestTimeout: 10000 },
  clientCapabilities: {},
  hostContext: {},
});

const inputs = [
  { label: "base-minimal", input: base() },
  {
    label: "explicit-false-flags",
    input: {
      ...base(),
      progressiveToolDiscovery: false,
      respectToolVisibility: false,
    },
  },
  {
    label: "headers-and-caps-key-order",
    input: {
      ...base(),
      connectionDefaults: {
        headers: { "X-Z": "1", "A-Header": "2", "m-mid": "3" },
        requestTimeout: 30000,
      },
      clientCapabilities: { zeta: true, alpha: { nested: 1, deep: 2 } },
      hostContext: { b: 2, a: 1 },
    },
  },
  {
    label: "server-ids-unsorted-plus-overrides",
    input: {
      ...base(),
      serverIds: ["srv-c", "srv-a", "srv-b"],
      optionalServerIds: ["opt-z", "opt-a"],
      serverConnectionOverrides: {
        "srv-b": {
          headersOverride: { "Z": "1", "A": "2" },
          requestTimeoutOverride: 5000,
          mcpProtocolVersionOverride: "2025-06-18",
        },
        // No-content entry is stripped during canonicalization.
        "srv-a": {},
      },
    },
  },
  {
    label: "mcp-profile-initialize-order-preserved",
    input: {
      ...base(),
      mcpProfile: {
        profileVersion: 1,
        initialize: {
          supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
          clientInfo: { version: "1.2.3", name: "mcpjam", title: "MCPJam" },
        },
      },
    },
  },
  {
    label: "mcp-profile-stateful-pin-derives-supported",
    input: {
      ...base(),
      mcpProfile: { profileVersion: 1, mcpProtocolVersion: "2025-06-18" },
    },
  },
  {
    label: "mcp-profile-stateless-pin-no-derivation",
    input: {
      ...base(),
      mcpProfile: { profileVersion: 1, mcpProtocolVersion: "2026-07-28" },
    },
  },
  {
    label: "sandbox-csp-restrictto-sorted-plus-directives",
    input: {
      ...base(),
      mcpProfile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            csp: {
              mode: "declared",
              restrictTo: {
                connectDomains: ["b.example.com", "a.example.com", "b.example.com"],
                frameDomains: ["x.example.com"],
              },
              cspDirectives: { "script-src": ["'wasm-unsafe-eval'", "'unsafe-eval'"] },
            },
          },
        },
      },
    },
  },
  {
    label: "sandbox-permissions-allow-key-order",
    input: {
      ...base(),
      mcpProfile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            permissions: {
              mode: "custom",
              allow: { microphone: true, camera: false },
            },
          },
        },
      },
    },
  },
  {
    label: "sandbox-allowfeatures-drops-spec-features",
    input: {
      ...base(),
      mcpProfile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            // camera/clipboard-write are spec features → dropped; fullscreen kept.
            allowFeatures: { "camera": "*", "fullscreen": "'self'", "clipboard-write": "*" },
          },
        },
      },
    },
  },
  {
    label: "compat-runtime-openai-overrides",
    input: {
      ...base(),
      hostStyle: "chatgpt",
      mcpProfile: {
        profileVersion: 1,
        apps: {
          compatRuntime: {
            openaiApps: true,
            openaiAppsOverrides: {
              requestDisplayMode: "fullscreen-only",
              uploadFile: false,
              callTool: true,
            },
          },
        },
      },
    },
  },
  {
    label: "mcp-apps-overrides-display-modes-reordered",
    input: {
      ...base(),
      mcpProfile: {
        profileVersion: 1,
        apps: {
          mcpAppsOverrides: {
            availableDisplayModes: ["pip", "inline"],
            widgetDisplayModeRequests: "user-initiated-only",
            logging: true,
          },
        },
      },
    },
  },
  {
    label: "host-capabilities-override-explicit-empty",
    input: { ...base(), hostCapabilitiesOverride: {}, chatUiOverride: { logo: "x" } },
  },
  {
    label: "adversarial-stray-deny-must-be-dropped",
    input: {
      ...base(),
      mcpProfile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            csp: {
              mode: "declared",
              restrictTo: { connectDomains: ["api.example.com"] },
              // Stray legacy/foreign field — allowlist-only shape must drop it.
              deny: { connectDomains: ["evil.example.com"] },
            },
            permissions: {
              mode: "custom",
              allow: { camera: true },
              // Stray legacy deny[] — must be dropped.
              deny: ["microphone"],
            },
          },
        },
      },
    },
  },
];

const rows = [];
for (const { label, input } of inputs) {
  const canonicalJson = JSON.stringify(canonicalizeHostConfigV2(input));
  const sha256 = await computeHostConfigHashV2(input);
  rows.push({ label, input, canonicalJson, sha256 });
}

const __inputHash = await sha256Hex(JSON.stringify(rows));
const fixture = { __inputHash, rows };

writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.log(`Wrote ${rows.length} rows to ${outPath}`);
console.log(`__inputHash: ${__inputHash}`);
