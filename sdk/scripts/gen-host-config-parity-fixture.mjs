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
    label: "mcp-profile-tool-param-header-mirroring-omit",
    input: {
      ...base(),
      mcpProfile: { profileVersion: 1, toolParamHeaderMirroring: "omit" },
    },
  },
  {
    label: "mcp-profile-tool-param-header-mirroring-mirror",
    input: {
      ...base(),
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "2026-07-28",
        toolParamHeaderMirroring: "mirror",
      },
    },
  },
  {
    // Stateful pin + mirroring: the SDK derives `initialize` for a stateful
    // pin, so this pins the profile KEY ORDER across all four fields. The
    // backend reproduces these bytes through a shim, and its own canonicalizer
    // emits `initialize` before `mcpProtocolVersion` — so without an explicit
    // target order it would hash differently. This vector is what catches that.
    label: "mcp-profile-tool-param-header-mirroring-with-stateful-pin",
    input: {
      ...base(),
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "2025-11-25",
        toolParamHeaderMirroring: "omit",
      },
    },
  },
  // ── Client-conformance knobs (siblings of toolParamHeaderMirroring) ──
  // One vector per knob's non-default value, a default-literals vector
  // (stored, hashes distinctly from absent), and a combined vector with a
  // stateful pin that pins profile KEY ORDER against the backend shim.
  {
    label: "mcp-profile-conformance-pagination-first-page-only",
    input: {
      ...base(),
      mcpProfile: { profileVersion: 1, paginationTraversal: "firstPageOnly" },
    },
  },
  {
    label: "mcp-profile-conformance-mrtr-support-none",
    input: {
      ...base(),
      mcpProfile: { profileVersion: 1, mrtrSupport: "none" },
    },
  },
  {
    // Default literals are storable and hash distinctly from absent
    // (same discipline as toolParamHeaderMirroring: "mirror").
    label: "mcp-profile-conformance-default-literals",
    input: {
      ...base(),
      mcpProfile: {
        profileVersion: 1,
        paginationTraversal: "full",
        mrtrSupport: "full",
      },
    },
  },
  {
    // Both knobs non-default + mirroring + a stateful pin. The pin makes
    // the SDK derive `initialize`, so this vector pins the full profile KEY
    // ORDER (profileVersion first, then alphabetical) that the backend
    // shim must reproduce byte-identically.
    label: "mcp-profile-conformance-combined-with-stateful-pin",
    input: {
      ...base(),
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "2025-11-25",
        toolParamHeaderMirroring: "omit",
        paginationTraversal: "firstPageOnly",
        mrtrSupport: "none",
      },
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
    label: "computer-personal-with-untrimmed-workdir",
    input: {
      ...base(),
      computer: { kind: "personal", toolset: "bash", workdir: " /home/u " },
    },
  },
  {
    // Runtime-minted kind: the platform stamps `{ kind: "ephemeral" }` at a
    // run-snapshot boundary (one box per eval iteration, booted from the
    // run's frozen environment image). Authors can never write it, but it is
    // persisted and content-addressed, so it needs a golden vector. Hashes
    // distinctly from the personal vector above.
    label: "computer-ephemeral",
    input: { ...base(), computer: { kind: "ephemeral" } },
  },
  {
    // `toolset` is legacy input for EVERY kind, not just personal: accepted
    // then dropped. This vector proves `{ kind: "ephemeral", toolset }` and
    // `{ kind: "ephemeral" }` are the same identity — the backend runs the
    // same `shimLegacyComputerToolset` pipeline, so the two canonicalizers
    // must not diverge on it.
    label: "computer-ephemeral-with-toolset-dropped",
    input: { ...base(), computer: { kind: "ephemeral", toolset: "bash" } },
  },
  {
    // Optional harness selector. Absent ⇒ emulated (base-minimal proves that
    // hash is unchanged); an explicit "claude-code" writes the key and hashes
    // distinctly. Validated pass-through, like progressiveToolDiscovery.
    label: "harness-claude-code",
    input: { ...base(), harness: "claude-code" },
  },
  {
    // A harness id the BACKEND's pinned @mcpjam/sdk release does not know.
    // The backend masks it to "claude-code" past that release's HARNESS_IDS
    // guard and overwrites the key on the way out (`withSdkSafeHarness`), so
    // this vector is the proof that the mask/restore round-trip is
    // byte-identical to what a cursor-aware canonicalizer emits — key position
    // included. Without it, the shim could silently reorder the canonical JSON
    // and every shim-era row would need a rehash at the next dep bump.
    label: "harness-cursor",
    input: { ...base(), harness: "cursor" },
  },
  {
    // Empty builtInToolIds collapses to absent → canonical JSON has no key,
    // byte-identical to base-minimal for that dimension (hash-neutral default).
    label: "builtin-tool-ids-empty-omitted",
    input: { ...base(), builtInToolIds: [] },
  },
  {
    // Unsorted + duplicate opaque ids → deduped + sorted in the canonical shape.
    label: "builtin-tool-ids-unsorted-dupes",
    input: { ...base(), builtInToolIds: ["web_search", "code_exec", "web_search"] },
  },
  {
    // `{ mode: "all-visible" }` canonicalizes to ABSENT: same runtime
    // behavior as a legacy row with no skillSelection, so it must produce
    // the same content-addressed identity (byte-identical to base-minimal).
    label: "skill-selection-all-visible-omitted",
    input: { ...base(), skillSelection: { mode: "all-visible" } },
  },
  {
    // Explicit selection with unsorted + duplicate ids → deduped + sorted.
    label: "skill-selection-explicit-unsorted-dupes",
    input: {
      ...base(),
      skillSelection: { mode: "explicit", skillIds: ["sk-b", "sk-a", "sk-b"] },
    },
  },
  {
    // Explicit-EMPTY ("no standalone skills") is preserved — absence is
    // semantic here, so this MUST hash differently from base-minimal.
    label: "skill-selection-explicit-empty-preserved",
    input: { ...base(), skillSelection: { mode: "explicit", skillIds: [] } },
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
