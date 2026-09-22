import { describe, expect, it } from "vitest";
import {
  APPS_CHECK_CATALOG,
  PROTOCOL_CHECK_CATALOG,
  TASKS_CHECK_CATALOG,
  type ConformanceCheckInfo,
} from "../src/conformance-catalog.js";
import { MCP_CHECK_IDS } from "../src/mcp-conformance/types.js";
import { MCP_APPS_CHECK_IDS } from "../src/apps-conformance/types.js";
import { MCP_TASKS_CHECK_IDS } from "../src/tasks-conformance/types.js";
import { CORE_CHECKS } from "../src/mcp-conformance/checks/core.js";
import { TOOL_CHECKS } from "../src/mcp-conformance/checks/tools.js";
import { PROMPT_CHECKS } from "../src/mcp-conformance/checks/prompts.js";
import { RESOURCE_CHECKS } from "../src/mcp-conformance/checks/resources.js";
import { MODERN_CHECK_METADATA } from "../src/mcp-conformance/checks/modern.js";
import { WIRE_CHECK_METADATA } from "../src/mcp-conformance/checks/wire.js";
import { PROTOCOL_CHECK_METADATA } from "../src/mcp-conformance/checks/protocol.js";
import { SECURITY_CHECK_METADATA } from "../src/mcp-conformance/checks/security.js";
import { TRANSPORT_CHECK_METADATA } from "../src/mcp-conformance/checks/transport.js";
import { APPS_CHECK_METADATA } from "../src/apps-conformance/runner.js";
import { CHECK_METADATA as TASKS_CHECK_METADATA } from "../src/tasks-conformance/runner.js";

/**
 * `src/conformance-catalog.ts` is a browser-safe copy of strings whose
 * canonical home is next to each check implementation — the runner modules
 * are unimportable from a browser bundle, which is the whole reason the copy
 * exists. These tests are what keeps the copy honest: edit a title or
 * description on either side without the other and this fails.
 */

type CanonicalInfo = { title: string; description: string };

/** Every canonical protocol source, flattened to id → {title, description}. */
function canonicalProtocolInfo(): Record<string, CanonicalInfo> {
  const flat: Record<string, CanonicalInfo> = {};

  for (const definition of [
    ...CORE_CHECKS,
    ...TOOL_CHECKS,
    ...PROMPT_CHECKS,
    ...RESOURCE_CHECKS,
  ]) {
    flat[definition.id] = {
      title: definition.title,
      description: definition.description,
    };
  }

  for (const source of [
    MODERN_CHECK_METADATA,
    PROTOCOL_CHECK_METADATA,
    SECURITY_CHECK_METADATA,
    TRANSPORT_CHECK_METADATA,
    WIRE_CHECK_METADATA,
  ]) {
    for (const entry of Object.values(
      source as Record<string, CanonicalInfo & { id: string }>,
    )) {
      flat[entry.id] = { title: entry.title, description: entry.description };
    }
  }

  return flat;
}

function toInfo(entry: CanonicalInfo): ConformanceCheckInfo {
  return { title: entry.title, description: entry.description };
}

describe("conformance catalog", () => {
  it("covers every protocol check id, and only those", () => {
    expect(Object.keys(PROTOCOL_CHECK_CATALOG).sort()).toEqual(
      [...MCP_CHECK_IDS].sort(),
    );
  });

  it("covers every apps check id, and only those", () => {
    expect(Object.keys(APPS_CHECK_CATALOG).sort()).toEqual(
      [...MCP_APPS_CHECK_IDS].sort(),
    );
  });

  it("covers every tasks check id, and only those", () => {
    expect(Object.keys(TASKS_CHECK_CATALOG).sort()).toEqual(
      [...MCP_TASKS_CHECK_IDS].sort(),
    );
  });

  it("matches the canonical protocol titles and descriptions", () => {
    const canonical = canonicalProtocolInfo();

    // Non-vacuity: a refactor that stops exporting the canonical sources must
    // fail loudly here rather than leave an empty comparison passing.
    expect(Object.keys(canonical).sort()).toEqual([...MCP_CHECK_IDS].sort());

    for (const id of MCP_CHECK_IDS) {
      expect({ id, ...PROTOCOL_CHECK_CATALOG[id] }).toEqual({
        id,
        ...toInfo(canonical[id]!),
      });
    }
  });

  it("matches the canonical apps titles and descriptions", () => {
    for (const id of MCP_APPS_CHECK_IDS) {
      expect({ id, ...APPS_CHECK_CATALOG[id] }).toEqual({
        id,
        ...toInfo(APPS_CHECK_METADATA[id]),
      });
    }
  });

  it("matches the canonical tasks titles and descriptions", () => {
    for (const id of MCP_TASKS_CHECK_IDS) {
      expect({ id, ...TASKS_CHECK_CATALOG[id] }).toEqual({
        id,
        ...toInfo(TASKS_CHECK_METADATA[id]),
      });
    }
  });
});
