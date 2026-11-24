/**
 * Audit 1 acceptance cases that touch families 1–17, at the rule level: what
 * the catalog says for each case before the evaluator combines sources.
 */

import { describe, expect, it } from "vitest";
import { fullCoverage, makeSurface } from "../../../__tests__/fixtures.js";
import {
  COVERAGE_KEYS,
  type CoverageKey,
  type CoverageState,
  type DeclaredSurface,
} from "../../../types.js";
import { CORE_FEATURES } from "../index.js";
import { declared, isGap, kindOf } from "./helpers.js";

const withDeclaredRule = CORE_FEATURES.filter(
  (entry) => entry.assessment.declared
);

function gapsOn(surface: DeclaredSurface): string[] {
  return withDeclaredRule
    .filter((entry) =>
      isGap(entry.assessment.declared?.(surface) ?? null, surface)
    )
    .map((entry) => entry.id);
}

function coverageAll(state: CoverageState): Record<CoverageKey, CoverageState> {
  return fullCoverage(
    Object.fromEntries(COVERAGE_KEYS.map((key) => [key, state])) as Partial<
      Record<CoverageKey, CoverageState>
    >
  );
}

/** A rich server whose surface every case below degrades in one way. */
const richSurface = (overrides: Partial<DeclaredSurface> = {}) =>
  makeSurface({
    serverInfo: { name: "fixture", version: "1.0.0" },
    capabilities: { tools: { listChanged: true } },
    tools: [
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { q: { $ref: "#/$defs/q" } },
        },
        _meta: { "acme/x": true },
      },
    ],
    ...overrides,
  });

describe("audit 1 acceptance cases", () => {
  it("case 1: a tools-only server is valid; missing optional families are opportunities", () => {
    const toolsOnly = richSurface();
    expect(kindOf(declared("server-info.name-version", toolsOnly))).toBe(
      "present"
    );
    expect(kindOf(declared("tools.list", toolsOnly))).toBe("present");
    for (const id of [
      "prompts.list",
      "resources.list",
      "resource-templates.list",
    ]) {
      const entry = CORE_FEATURES.find((candidate) => candidate.id === id);
      expect(isGap(declared(id, toolsOnly), toolsOnly), id).toBe(true);
      expect(entry?.optional, id).toBe(true);
      expect(entry?.owner, id).toBe("server");
    }
  });

  it("case 2: an old snapshot with nothing captured yields no gap anywhere", () => {
    const legacy = richSurface({
      envelopeVersion: 2,
      serverInfo: undefined,
      capabilities: undefined,
      tools: [],
      coverage: coverageAll("not-captured"),
    });
    expect(gapsOn(legacy)).toEqual([]);
  });

  it("case 3: metadata or $ref stripped by storage is unknown, not absent", () => {
    const stripped = richSurface({
      tools: [{ name: "search", inputSchema: { type: "object" } }],
      coverage: fullCoverage({ toolMeta: "partial", toolSchemas: "partial" }),
    });
    expect(isGap(declared("tools.meta", stripped), stripped)).toBe(false);
    expect(kindOf(declared("tools.schema-ref-bounds", stripped))).toBe(
      "unknown"
    );
    expect(isGap(declared("tools.output-schema", stripped), stripped)).toBe(
      false
    );
  });

  it("case 6: a partial or failed list never supports a complete-inventory negative", () => {
    for (const state of ["partial", "not-captured"] as const) {
      const partial = richSurface({
        tools: [],
        prompts: [],
        resources: [],
        resourceTemplates: [],
        coverage: fullCoverage({
          tools: state,
          prompts: state,
          resources: state,
          resourceTemplates: state,
          listHints: state,
        }),
      });
      // Only capability and serverInfo negatives survive; nothing read from a list.
      for (const entry of withDeclaredRule) {
        const outcome = entry.assessment.declared?.(partial) ?? null;
        if (!isGap(outcome, partial) || outcome?.kind !== "absent") continue;
        for (const key of outcome.basis) {
          expect(
            ["capabilities", "serverInfo", "instructions"],
            entry.id
          ).toContain(key);
        }
      }
    }
  });

  it("case 7: explicit false, omitted defaults, empty objects and forbidden read correctly", () => {
    const surface = richSurface({
      capabilities: { tools: {}, prompts: { listChanged: false } },
      tools: [
        {
          name: "a",
          inputSchema: { type: "object" },
          annotations: { destructiveHint: false },
          execution: { taskSupport: "forbidden" },
        },
      ],
    });
    expect(kindOf(declared("tools.capability", surface))).toBe("present");
    expect(
      kindOf(declared("tools.annotations.destructive-hint", surface))
    ).toBe("present");
    expect(kindOf(declared("tools.annotations.read-only-hint", surface))).toBe(
      "absent"
    );
    expect(kindOf(declared("prompts.list-changed", surface))).toBe("absent");
    expect(kindOf(declared("tools.execution.task-support", surface))).toBe(
      "absent"
    );
  });

  it("case 10: input_required is observable on reads and prompts, not only tools", () => {
    const observable = new Set(
      CORE_FEATURES.filter((entry) => entry.assessment.observable).map(
        (entry) => entry.id
      )
    );
    expect(observable.has("mrtr.input-required")).toBe(true);
    expect(observable.has("resources.read-input-required")).toBe(true);
    expect(observable.has("prompts.get")).toBe(true);
  });

  it("case 16: an unknown future revision borrows no current rules", () => {
    const future = richSurface({ protocolVersion: "2099-01-01" });
    expect(kindOf(declared("lifecycle.initialize", future))).toBe("unknown");
    expect(kindOf(declared("lifecycle.version-negotiation", future))).toBe(
      "unknown"
    );
    expect(kindOf(declared("lifecycle.extensions", future))).toBe("unknown");
    expect(declared("lifecycle.server-discover", future)).toBeNull();
  });

  it("case 18: empty required fields are not read as present", () => {
    const blank = richSurface({ serverInfo: { name: "", version: "  " } });
    expect(kindOf(declared("server-info.name-version", blank))).toBe("absent");
  });
});

describe("observable features", () => {
  it("is the exact list the traffic classifier is built from", () => {
    const observable = CORE_FEATURES.filter(
      (entry) => entry.assessment.observable
    ).map((entry) => entry.id);
    expect(observable).toMatchInlineSnapshot(`
      [
        "server-info.result-server-info",
        "lifecycle.missing-client-capability-error",
        "transport-behavior.server-requests-on-sse",
        "mrtr.input-required",
        "mrtr.input-request-types",
        "mrtr.request-state",
        "mrtr.load-shedding",
        "mrtr.input-meta",
        "subscriptions.resources-subscribe",
        "subscriptions.legacy-subscribe",
        "subscriptions.resource-updated",
        "subscriptions.listen",
        "subscriptions.acknowledged",
        "subscriptions.subscription-id",
        "subscriptions.list-changed-on-stream",
        "subscriptions.stream-end",
        "subscriptions.legacy-delivery",
        "tools.list-changed",
        "tool-results.content",
        "tool-results.text",
        "tool-results.image",
        "tool-results.audio",
        "tool-results.resource-link",
        "tool-results.embedded-resource",
        "tool-results.content-annotations",
        "tool-results.structured-content",
        "tool-results.is-error",
        "tool-results.result-type",
        "tool-results.result-meta",
        "resources.read",
        "resources.list-changed",
        "resources.read-input-required",
        "resource-templates.updated",
        "prompts.get",
        "prompts.message-content",
        "prompts.list-changed",
        "completion.prompt-ref",
        "completion.resource-ref",
        "pagination.cursor",
        "caching.no-hints-on-input-required",
        "request-control.progress",
        "request-control.cancellation",
        "request-control.ping",
        "request-control.logging-set-level",
        "request-control.log-messages",
        "client.roots",
        "client.roots-list-changed",
        "client.sampling",
        "client.sampling-tools",
        "client.include-context",
        "client.elicitation-form",
        "client.elicitation-url",
        "client.url-elicitation-required-error",
        "client.elicitation-complete",
        "client.elicitation-schemas",
      ]
    `);
  });
});
