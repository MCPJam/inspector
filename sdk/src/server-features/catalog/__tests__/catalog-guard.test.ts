/**
 * CI guard over the whole feature catalog (core and extensions). It holds
 * while the extensions half is empty and keeps holding once it is filled:
 * family-specific assertions here cover families 1–17 only.
 */

import { describe, expect, it } from "vitest";
import { MCP_PROTOCOL_VERSIONS } from "../../../mcp-client-manager/mcp-protocol-version.js";
import {
  CORE_WIRE_SCHEMAS,
  definitionsPointer,
  type WireSchemaDocument,
} from "../../../mcp-conformance/schemas/index.js";
import { MCP_CHECK_IDS } from "../../../mcp-conformance/types.js";
import { CONFORMANCE_CHECK_METADATA } from "../../../oauth-conformance/types.js";
import { CHECK_FEATURE_MAPS } from "../../check-map/index.js";
import { OAUTH_CHECK_FEATURES } from "../../check-map/oauth.js";
import { PROTOCOL_CHECK_FEATURES } from "../../check-map/protocol.js";
import { FEATURE_FAMILY_IDS, type FeatureFamilyId } from "../../types.js";
import { CORE_FEATURES } from "../core/index.js";
import { SERVER_FEATURE_CATALOG } from "../index.js";
import {
  CORE_REVISIONS,
  compareCoreRevisions,
  isCoreRevision,
} from "../revisions.js";
import { SPEC_PINS } from "../spec-refs.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9.\-]{0,95}$/;
const CATALOG = SERVER_FEATURE_CATALOG;
const IDS = new Set(CATALOG.map((feature) => feature.id));

/** Families 1–17 in display order; the extensions lane guards the rest. */
const CORE_FAMILIES = FEATURE_FAMILY_IDS.slice(
  0,
  FEATURE_FAMILY_IDS.indexOf("core-authorization") + 1
);

describe("catalog ids and tree", () => {
  it("gives every entry a unique id the backend accepts", () => {
    const seen = new Set<string>();
    for (const feature of CATALOG) {
      expect(feature.id, feature.id).toMatch(ID_PATTERN);
      expect(seen.has(feature.id), `duplicate id ${feature.id}`).toBe(false);
      seen.add(feature.id);
    }
  });

  it("puts each parent earlier in the array and in the same family", () => {
    const position = new Map(
      CATALOG.map((feature, index) => [feature.id, index])
    );
    CATALOG.forEach((feature, index) => {
      if (!feature.parent) return;
      const parentIndex = position.get(feature.parent) ?? -1;
      expect(
        parentIndex,
        `${feature.id} names a missing parent`
      ).toBeGreaterThanOrEqual(0);
      expect(parentIndex < index, `${feature.id} precedes its parent`).toBe(
        true
      );
      expect(CATALOG[parentIndex]?.family, feature.id).toBe(feature.family);
    });
  });

  it("uses only known families", () => {
    for (const feature of CATALOG) {
      expect(FEATURE_FAMILY_IDS, feature.id).toContain(feature.family);
    }
  });

  it("fills every core family, in display order, one block per family", () => {
    const order = CORE_FEATURES.map((feature) => feature.family);
    const blocks = order.filter((family, index) => family !== order[index - 1]);
    expect(blocks).toEqual(CORE_FAMILIES);
    expect(
      CORE_FEATURES.every((feature) => CORE_FAMILIES.includes(feature.family))
    ).toBe(true);
  });
});

describe("catalog entries", () => {
  it("has a name, summary, how-to and pinned https spec link", () => {
    for (const feature of CATALOG) {
      const label = feature.id;
      expect(feature.name.trim(), label).not.toBe("");
      expect(feature.summary.trim(), label).not.toBe("");
      expect(feature.howTo.trim(), label).not.toBe("");
      expect(new URL(feature.spec.url).protocol, label).toBe("https:");
      expect(feature.spec.pin, label).toBe(SPEC_PINS[feature.spec.source]);
      expect(feature.spec.checkedAt, label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("keeps user-facing text free of dashes used as punctuation", () => {
    for (const feature of CATALOG) {
      for (const text of [feature.name, feature.summary, feature.howTo]) {
        expect(text, feature.id).not.toMatch(/[–—]/);
      }
    }
  });

  it("names only known revisions, in order, in each lifecycle", () => {
    for (const feature of CATALOG) {
      const { introduced, deprecated, removed } = feature.lifecycle;
      const named = [introduced, deprecated, removed].filter(
        (version): version is string => version !== undefined
      );
      for (const version of named) {
        expect(isCoreRevision(version), `${feature.id}: ${version}`).toBe(true);
      }
      if (introduced && deprecated) {
        expect(
          compareCoreRevisions(introduced, deprecated),
          feature.id
        ).toBeLessThanOrEqual(0);
      }
      if (introduced && removed) {
        expect(
          compareCoreRevisions(introduced, removed),
          feature.id
        ).toBeLessThan(0);
      }
      if (deprecated && removed) {
        expect(
          compareCoreRevisions(deprecated, removed),
          feature.id
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  it("gives every set-up feature a setup kind", () => {
    for (const feature of CATALOG) {
      if (feature.assessment.primary === "configured") {
        expect(feature.assessment.setup, feature.id).toBeDefined();
      }
    }
  });
});

describe("protocol revisions", () => {
  it("lists revisions oldest first", () => {
    expect([...CORE_REVISIONS].sort()).toEqual([...CORE_REVISIONS]);
  });

  it("knows every protocol version MCPJam can pin", () => {
    for (const version of MCP_PROTOCOL_VERSIONS) {
      expect(isCoreRevision(version), version).toBe(true);
    }
  });
});

describe("check maps", () => {
  it("maps only to features that exist", () => {
    for (const [suite, map] of Object.entries(CHECK_FEATURE_MAPS)) {
      for (const [checkId, target] of Object.entries(map)) {
        if (target === undefined || target === "excluded") continue;
        expect(target.length, `${suite}:${checkId}`).toBeGreaterThan(0);
        for (const featureId of target) {
          expect(IDS.has(featureId), `${suite}:${checkId} → ${featureId}`).toBe(
            true
          );
        }
      }
    }
  });

  it("covers exactly the protocol suite's check ids", () => {
    expect(Object.keys(PROTOCOL_CHECK_FEATURES).sort()).toEqual(
      [...MCP_CHECK_IDS].sort()
    );
  });

  it("covers exactly the OAuth suite's check ids", () => {
    expect(Object.keys(OAUTH_CHECK_FEATURES).sort()).toEqual(
      Object.keys(CONFORMANCE_CHECK_METADATA).sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Published schemas: every method and capability path has a row
// ---------------------------------------------------------------------------

/**
 * A feature list, a reviewed exclusion, or a family whose rows the extensions
 * lane owns (2025-11-25 core Tasks moved to the Tasks family).
 */
type SchemaTarget =
  | readonly string[]
  | { excluded: string }
  | { family: FeatureFamilyId };

const METHOD_TARGETS: Record<string, SchemaTarget> = {
  initialize: ["lifecycle.initialize"],
  "notifications/initialized": ["lifecycle.initialize"],
  "server/discover": ["lifecycle.server-discover"],
  ping: ["request-control.ping"],
  "logging/setLevel": ["request-control.logging-set-level"],
  "notifications/message": ["request-control.log-messages"],
  "notifications/progress": ["request-control.progress"],
  "notifications/cancelled": ["request-control.cancellation"],
  "completion/complete": ["completion.prompt-ref", "completion.resource-ref"],
  "tools/list": ["tools.list"],
  "tools/call": ["tool-results.content"],
  "notifications/tools/list_changed": ["tools.list-changed"],
  "resources/list": ["resources.list"],
  "resources/read": ["resources.read"],
  "resources/templates/list": ["resource-templates.list"],
  "resources/subscribe": ["subscriptions.legacy-subscribe"],
  "resources/unsubscribe": ["subscriptions.legacy-subscribe"],
  "notifications/resources/updated": [
    "subscriptions.resource-updated",
    "resource-templates.updated",
  ],
  "notifications/resources/list_changed": ["resources.list-changed"],
  "prompts/list": ["prompts.list"],
  "prompts/get": ["prompts.get"],
  "notifications/prompts/list_changed": ["prompts.list-changed"],
  "roots/list": ["client.roots"],
  "notifications/roots/list_changed": ["client.roots-list-changed"],
  "sampling/createMessage": ["client.sampling"],
  "elicitation/create": ["client.elicitation-form", "client.elicitation-url"],
  "notifications/elicitation/complete": ["client.elicitation-complete"],
  "subscriptions/listen": ["subscriptions.listen"],
  "notifications/subscriptions/acknowledged": ["subscriptions.acknowledged"],
  "tasks/get": { family: "tasks" },
  "tasks/result": { family: "tasks" },
  "tasks/list": { family: "tasks" },
  "tasks/cancel": { family: "tasks" },
  "notifications/tasks/status": { family: "tasks" },
};

const CAPABILITY_TARGETS: Record<string, SchemaTarget> = {
  "ServerCapabilities.completions": ["completion.capability"],
  "ServerCapabilities.experimental": ["server-info.experimental"],
  "ServerCapabilities.extensions": ["lifecycle.extensions"],
  "ServerCapabilities.logging": ["request-control.logging"],
  "ServerCapabilities.prompts": ["prompts.capability"],
  "ServerCapabilities.prompts.listChanged": ["prompts.list-changed"],
  "ServerCapabilities.resources": ["resources.capability"],
  "ServerCapabilities.resources.listChanged": ["resources.list-changed"],
  "ServerCapabilities.resources.subscribe": [
    "subscriptions.resources-subscribe",
  ],
  "ServerCapabilities.tools": ["tools.capability"],
  "ServerCapabilities.tools.listChanged": ["tools.list-changed"],
  "ServerCapabilities.tasks": { family: "tasks" },
  "ServerCapabilities.tasks.cancel": { family: "tasks" },
  "ServerCapabilities.tasks.list": { family: "tasks" },
  "ServerCapabilities.tasks.requests": { family: "tasks" },
  "ClientCapabilities.elicitation": ["client.elicitation"],
  "ClientCapabilities.elicitation.form": ["client.elicitation-form"],
  "ClientCapabilities.elicitation.url": ["client.elicitation-url"],
  "ClientCapabilities.experimental": {
    excluded: "Client experimental capabilities say nothing about the server.",
  },
  "ClientCapabilities.extensions": ["lifecycle.extensions"],
  "ClientCapabilities.roots": ["client.roots"],
  "ClientCapabilities.roots.listChanged": ["client.roots-list-changed"],
  "ClientCapabilities.sampling": ["client.sampling"],
  "ClientCapabilities.sampling.context": ["client.include-context"],
  "ClientCapabilities.sampling.tools": ["client.sampling-tools"],
  "ClientCapabilities.tasks": { family: "tasks" },
  "ClientCapabilities.tasks.cancel": { family: "tasks" },
  "ClientCapabilities.tasks.list": { family: "tasks" },
  "ClientCapabilities.tasks.requests": { family: "tasks" },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaMethods(document: WireSchemaDocument): string[] {
  const { definitions } = definitionsPointer(document);
  const methods = new Set<string>();
  for (const definition of Object.values(definitions)) {
    if (!isObject(definition) || !isObject(definition.properties)) continue;
    const method = definition.properties.method;
    if (isObject(method) && typeof method.const === "string") {
      methods.add(method.const);
    }
  }
  return [...methods];
}

/** `Capabilities.key` and `Capabilities.key.sub` paths, with `$ref`s followed. */
function capabilityPaths(document: WireSchemaDocument): string[] {
  const { definitions } = definitionsPointer(document);
  const resolve = (value: unknown): unknown => {
    if (!isObject(value) || typeof value.$ref !== "string") return value;
    return definitions[value.$ref.split("/").pop() ?? ""];
  };
  const paths: string[] = [];
  for (const root of ["ServerCapabilities", "ClientCapabilities"]) {
    const definition = definitions[root];
    if (!isObject(definition) || !isObject(definition.properties)) continue;
    for (const [key, value] of Object.entries(definition.properties)) {
      paths.push(`${root}.${key}`);
      const resolved = resolve(value);
      if (!isObject(resolved) || !isObject(resolved.properties)) continue;
      for (const sub of Object.keys(resolved.properties)) {
        paths.push(`${root}.${key}.${sub}`);
      }
    }
  }
  return paths;
}

function expectTarget(name: string, target: SchemaTarget | undefined) {
  expect(
    target,
    `${name} has no catalog row or reviewed exclusion`
  ).toBeDefined();
  if (target === undefined) return;
  if (Array.isArray(target)) {
    for (const featureId of target) {
      expect(IDS.has(featureId), `${name} → ${featureId}`).toBe(true);
    }
  } else if ("family" in target) {
    expect(FEATURE_FAMILY_IDS, name).toContain(target.family);
  } else if ("excluded" in target) {
    expect(target.excluded.trim(), name).not.toBe("");
  }
}

describe("published schemas", () => {
  const revisions = Object.entries(CORE_WIRE_SCHEMAS);

  it("vendors a schema for every protocol version MCPJam can pin", () => {
    expect(revisions.map(([version]) => version).sort()).toEqual(
      [...MCP_PROTOCOL_VERSIONS].sort()
    );
  });

  it.each(revisions)("maps every %s method to a row", (_version, document) => {
    const methods = schemaMethods(document);
    expect(methods).toContain("tools/list");
    for (const method of methods) {
      expectTarget(method, METHOD_TARGETS[method]);
    }
  });

  it.each(revisions)(
    "maps every %s capability path to a row",
    (_version, document) => {
      const paths = capabilityPaths(document);
      expect(paths).toContain("ServerCapabilities.tools.listChanged");
      for (const path of paths) {
        expectTarget(path, CAPABILITY_TARGETS[path]);
      }
    }
  );

  it("keeps no mapping for a method or capability no schema has", () => {
    const methods = new Set(
      revisions.flatMap(([, document]) => schemaMethods(document))
    );
    const paths = new Set(
      revisions.flatMap(([, document]) => capabilityPaths(document))
    );
    expect(
      Object.keys(METHOD_TARGETS).filter((method) => !methods.has(method))
    ).toEqual([]);
    expect(
      Object.keys(CAPABILITY_TARGETS).filter((path) => !paths.has(path))
    ).toEqual([]);
  });
});
