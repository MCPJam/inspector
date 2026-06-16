import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Two-matrix architecture defense. The OpenAI Apps SDK shim matrix
 * (`window.openai.*`) and the SEP-1865 MCP Apps `app.*` spec-bridge
 * matrix are independent surfaces — they represent different APIs
 * from different specs and must never cross-gate. See
 * `feedback_two_matrix_architecture.md` (auto-memory) for the design
 * rule and the rationale behind enforcement-via-test instead of via
 * broad ESLint (`built-ins.ts` / `client-config-v2.ts` /
 * `AppsExtensionTab.tsx` legitimately import both types).
 *
 * These assertions read the source text of the runtime-gating
 * modules and verify that each one references at most ONE matrix's
 * runtime gate refs. Defensive: today (post foundation series PR A)
 * the MCP Apps matrix has no notification gates yet (those land in
 * PR B); the assertions pass trivially. When PR B adds
 * `bridge.sendToolInputPartial`-style gates reading the MCP Apps
 * matrix ref, these tests will catch any accidental wiring back into
 * the OpenAI shim matrix's refs (or vice versa).
 *
 * NB: source-text grep, not AST. We rely on the variable names being
 * stable identifiers in the code (renames to anything new also need
 * to update these tests).
 */

// Refs the OpenAI shim runtime uses to gate its postMessage handlers.
// If any of these appear in a module that's supposed to be MCP-Apps-
// only, that's a cross-matrix wiring bug.
const OPENAI_SHIM_RUNTIME_REFS = [
  "liveOpenAiCompatCapabilitiesRef",
  "liveOpenAiCompatCapabilities",
  "activeShimCapabilities",
  "openaiAppsOverrides",
];

// Refs the MCP Apps spec bridge runtime uses (or will use, when PR B
// lands) to gate its bridge handlers / notification emissions. If any
// of these appear in OpenAI-shim-only gating code, that's also a
// cross-matrix wiring bug.
const MCP_APPS_RUNTIME_REFS = [
  "mcpAppsOverrides",
  "mcpAppsCapabilities",
  "activeMcpAppsCapabilities",
  "resolveEffectiveMcpAppsCapabilities",
];

async function readSource(relativeFromTest: string): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFile(resolve(here, relativeFromTest), "utf8");
}

function assertNoRefs(
  body: string,
  refs: string[],
  context: { module: string; surface: string },
) {
  // Strip line / block comments before scanning so doc comments
  // explaining the architecture (which legitimately reference the
  // OTHER matrix's identifiers for context) don't trip the
  // assertion. Identifiers in real code paths are what we're
  // actually defending against.
  const code = body
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  for (const ref of refs) {
    expect(
      code.includes(ref),
      `${context.module} (the ${context.surface} surface) must not reference \`${ref}\` — that's a cross-matrix wiring bug. ` +
        `See feedback_two_matrix_architecture.md.`,
    ).toBe(false);
  }
}

describe("cross-matrix isolation", () => {
  it("useToolInputStreaming.ts (MCP Apps streaming surface) does not reference any OpenAI shim runtime refs", async () => {
    // `useToolInputStreaming` wraps `bridge.sendToolInputPartial`
    // (SEP-1865 spec bridge). PR B will gate it on the MCP Apps
    // matrix; today it gates on nothing matrix-related. Either way,
    // it must never read OpenAI shim refs.
    //
    // The implementation relocated to @mcpjam/widget-react in Phase
    // 3d-ii-b (the inspector `../useToolInputStreaming.ts` is now only a
    // re-export shim). Scan the REAL source in the package so this guard
    // keeps defending the actual code, not the shim.
    const body = await readSource(
      "../../../../../../../../widget-react/src/useToolInputStreaming.ts",
    );
    assertNoRefs(body, OPENAI_SHIM_RUNTIME_REFS, {
      module: "widget-react/src/useToolInputStreaming.ts",
      surface: "MCP Apps spec bridge (app.*)",
    });
  });

  it("mcp-apps-modal.tsx (MCP Apps modal AppBridge) does not reference any OpenAI shim runtime refs", async () => {
    // Modal mounts its own AppBridge with the resolved
    // HostCapabilities passed down from the inline renderer (#2230).
    // The modal MUST NOT read OpenAI shim matrix refs — its bridge
    // is SEP-1865 spec, not vendor shim.
    const body = await readSource("../mcp-apps-modal.tsx");
    assertNoRefs(body, OPENAI_SHIM_RUNTIME_REFS, {
      module: "mcp-apps-modal.tsx",
      surface: "MCP Apps spec bridge (app.*) — modal AppBridge",
    });
  });

  it("McpAppsCapabilityMatrix in AppsExtensionTab does not reference OpenAI shim matrix refs in its event handlers", async () => {
    // AppsExtensionTab is a boundary module — it legitimately imports
    // both matrix types (the two UI matrices stack there). The
    // narrower assertion: extract the McpAppsCapabilityMatrix
    // component body and verify ITS internals never read the OpenAI
    // matrix.
    const body = await readSource(
      "../../../../hosts/redesigned/focus/AppsExtensionTab.tsx",
    );
    const matrixStart = body.indexOf("function McpAppsCapabilityMatrix");
    expect(matrixStart, "McpAppsCapabilityMatrix component not found").not.toBe(
      -1,
    );
    // Component body runs until the next top-level function. Stop
    // at the matching closing brace of the component declaration.
    const matrixEnd = body.indexOf(
      "function McpAppsDimensionRow",
      matrixStart,
    );
    expect(matrixEnd, "next function after matrix not found").not.toBe(-1);
    const componentBody = body.slice(matrixStart, matrixEnd);
    assertNoRefs(componentBody, OPENAI_SHIM_RUNTIME_REFS, {
      module: "AppsExtensionTab.tsx › McpAppsCapabilityMatrix",
      surface: "MCP Apps spec bridge (app.*) matrix UI",
    });
  });

  it("OpenaiAppsCapabilityMatrix in AppsExtensionTab does not reference MCP Apps spec-bridge matrix refs in its event handlers", async () => {
    // Mirror assertion: the OpenAI matrix UI must not read MCP Apps
    // matrix refs. Same boundary-module caveat — we narrow to the
    // component body.
    const body = await readSource(
      "../../../../hosts/redesigned/focus/AppsExtensionTab.tsx",
    );
    const matrixStart = body.indexOf("function OpenaiAppsCapabilityMatrix");
    expect(matrixStart, "OpenaiAppsCapabilityMatrix component not found").not.toBe(
      -1,
    );
    const matrixEnd = body.indexOf(
      "function RequestDisplayModeControl",
      matrixStart,
    );
    expect(matrixEnd, "next function after openai matrix not found").not.toBe(
      -1,
    );
    const componentBody = body.slice(matrixStart, matrixEnd);
    assertNoRefs(componentBody, MCP_APPS_RUNTIME_REFS, {
      module: "AppsExtensionTab.tsx › OpenaiAppsCapabilityMatrix",
      surface: "window.openai shim matrix UI",
    });
  });
});
