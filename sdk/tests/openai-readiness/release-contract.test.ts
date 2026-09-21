/**
 * The release-contract delta matrix.
 *
 * One table, walked case by case, because the three outcomes have wildly
 * different costs and the differences between them are small:
 *
 *   - an ORIGIN change is a new plugin. A submitter who files it as an update
 *     loses the review and starts over, so this must never read as a version
 *     bump.
 *   - a PATH change IS a version bump, and reporting it as an origin change
 *     would tell someone to start over for a routine move.
 *   - a SCHEMA change is neither pass nor fail. An added optional property and
 *     a removed required one are both "the schema changed", and getting either
 *     verdict wrong costs a release or breaks users.
 */

import { describe, expect, it } from "vitest";

import {
  compareOpenAISnapshots,
  runOpenAIReleaseContractChecks,
} from "../../src/openai-readiness/checks/release-contract.js";
import {
  captureOpenAIMetadataSnapshot,
  type OpenAIMetadataSnapshot,
} from "../../src/openai-readiness/snapshot.js";
import type { OpenAIReadinessFinding } from "../../src/openai-readiness/types.js";

const STAMP = { evaluatedAt: "2026-08-19T12:00:00.000Z" };

const byId = (findings: OpenAIReadinessFinding[], id: string) =>
  findings.find((finding) => finding.id === id)!;

function snapshot(
  overrides: Partial<Parameters<typeof captureOpenAIMetadataSnapshot>[0]> = {},
): OpenAIMetadataSnapshot {
  return captureOpenAIMetadataSnapshot({
    endpointUrl: "https://plugin.example.com/mcp",
    instructions: "Use get_forecast for weather questions.",
    tools: [
      {
        name: "get_forecast",
        title: "Get forecast",
        description: "Look up a forecast",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
        annotations: { readOnlyHint: true },
      },
    ],
    uiResources: [
      {
        uri: "ui://weather/card",
        mimeType: "text/html;profile=mcp-app",
        domain: "card.weather.example.com",
        declaredCspDomains: ["cdn.example.com"],
      },
    ],
    ...overrides,
  });
}

const grade = (
  published: OpenAIMetadataSnapshot,
  draft: OpenAIMetadataSnapshot,
) =>
  runOpenAIReleaseContractChecks(
    { published, draft, hasPublishedVersion: true },
    STAMP,
  );

describe("applicability", () => {
  it("is not applicable to a first submission", () => {
    // Nothing was left unverified — there is no contract to break.
    const findings = runOpenAIReleaseContractChecks(
      { hasPublishedVersion: false },
      STAMP,
    );
    expect(
      findings.every((finding) => finding.status === "not-applicable"),
    ).toBe(true);
  });

  it("names the snapshot it lacks when a version IS published", () => {
    const findings = runOpenAIReleaseContractChecks(
      { hasPublishedVersion: true, draft: snapshot() },
      STAMP,
    );
    expect(
      findings.every((finding) => finding.status === "not-evaluated"),
    ).toBe(true);
    expect(
      (findings[0].details as { missingInput?: string })?.missingInput,
    ).toBe("publishedSnapshot");
  });
});

describe("an unchanged server", () => {
  it("reports no contract change", () => {
    const findings = grade(snapshot(), snapshot());
    expect(byId(findings, "openai.release.origin").status).toBe("satisfied");
    expect(byId(findings, "openai.release.contract").status).toBe("satisfied");
    expect(byId(findings, "openai.release.schema-compatibility").status).toBe(
      "satisfied",
    );
  });

  it("is not confused by tool or CSP ordering", () => {
    // Two scans of one server are free to list things in different orders, and
    // a comparison that treated order as contract would report drift forever.
    const published = captureOpenAIMetadataSnapshot({
      endpointUrl: "https://plugin.example.com/mcp",
      tools: [{ name: "b" }, { name: "a" }],
      uiResources: [
        {
          uri: "ui://x",
          declaredCspDomains: ["z.example.com", "a.example.com"],
        },
      ],
    });
    const draft = captureOpenAIMetadataSnapshot({
      endpointUrl: "https://plugin.example.com/mcp",
      tools: [{ name: "a" }, { name: "b" }],
      uiResources: [
        {
          uri: "ui://x",
          declaredCspDomains: ["a.example.com", "z.example.com"],
        },
      ],
    });
    expect(
      compareOpenAISnapshots(published, draft).filter(
        (delta) => delta.impact !== "live-compatible",
      ),
    ).toEqual([]);
  });

  it("is not confused by object key ordering in a schema", () => {
    const published = captureOpenAIMetadataSnapshot({
      endpointUrl: "https://plugin.example.com/mcp",
      tools: [{ name: "a", inputSchema: { type: "object", title: "A" } }],
    });
    const draft = captureOpenAIMetadataSnapshot({
      endpointUrl: "https://plugin.example.com/mcp",
      tools: [{ name: "a", inputSchema: { title: "A", type: "object" } }],
    });
    expect(compareOpenAISnapshots(published, draft)).toEqual([]);
  });
});

describe("the delta matrix", () => {
  it("classifies an origin change as a new plugin", () => {
    const findings = grade(
      snapshot(),
      snapshot({ endpointUrl: "https://plugin2.example.com/mcp" }),
    );
    const origin = byId(findings, "openai.release.origin");
    expect(origin.status).toBe("violated");
    // The one outcome a submitter must not discover late.
    expect(origin.remediation).toContain("new plugin");
  });

  it("treats a port change as an origin change", () => {
    const deltas = compareOpenAISnapshots(
      snapshot(),
      snapshot({ endpointUrl: "https://plugin.example.com:8443/mcp" }),
    );
    expect(deltas.some((delta) => delta.impact === "new-plugin-required")).toBe(
      true,
    );
  });

  it("treats a PATH change as an ordinary version bump", () => {
    // Reporting this as an origin change would tell someone to start over for
    // a routine move.
    const findings = grade(
      snapshot(),
      snapshot({ endpointUrl: "https://plugin.example.com/mcp/v2" }),
    );
    expect(byId(findings, "openai.release.origin").status).toBe("satisfied");
    expect(byId(findings, "openai.release.contract").status).toBe("violated");
  });

  for (const [label, draft] of [
    [
      "an added tool",
      snapshot({ tools: [{ name: "get_forecast" }, { name: "get_alerts" }] }),
    ],
    ["a removed tool", snapshot({ tools: [] })],
    [
      "a changed description",
      snapshot({
        tools: [{ name: "get_forecast", description: "Different" }],
      }),
    ],
    [
      "a changed annotation",
      snapshot({
        tools: [{ name: "get_forecast", annotations: { readOnlyHint: false } }],
      }),
    ],
    [
      "a changed security scheme",
      snapshot({
        tools: [{ name: "get_forecast", securitySchemes: ["oauth2"] }],
      }),
    ],
    [
      "a changed tool _meta",
      snapshot({
        tools: [{ name: "get_forecast", _meta: { "ui/uri": "ui://x" } }],
      }),
    ],
    [
      "changed instructions",
      snapshot({ instructions: "Something else entirely." }),
    ],
    [
      "a changed UI URI",
      snapshot({
        uiResources: [
          { uri: "ui://weather/card-v2", domain: "card.weather.example.com" },
        ],
      }),
    ],
    [
      "a changed CSP",
      snapshot({
        uiResources: [
          {
            uri: "ui://weather/card",
            mimeType: "text/html;profile=mcp-app",
            domain: "card.weather.example.com",
            declaredCspDomains: ["cdn.example.com", "new.example.com"],
          },
        ],
      }),
    ],
  ] as const) {
    it(`requires a rescan for ${label}`, () => {
      const findings = grade(snapshot(), draft);
      expect(byId(findings, "openai.release.contract").status).toBe("violated");
    });
  }
});

describe("schema compatibility is never decided automatically", () => {
  const widened = snapshot({
    tools: [
      {
        name: "get_forecast",
        title: "Get forecast",
        description: "Look up a forecast",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
            units: { type: "string" },
          },
        },
        annotations: { readOnlyHint: true },
      },
    ],
  });

  it("reports a changed schema as manual review rather than a failure", () => {
    // An added optional property and a removed required one are both "the
    // schema changed". Guessing either way costs a release or breaks users.
    const findings = grade(snapshot(), widened);
    const compatibility = byId(findings, "openai.release.schema-compatibility");
    expect(compatibility.status).toBe("not-evaluated");
    expect(compatibility.class).toBe("manual-review");
    expect(compatibility.notEvaluatedReason).toContain(
      "tools.get_forecast.inputSchema",
    );
  });

  it("does not let a schema change fail the contract check on its own", () => {
    const findings = grade(snapshot(), widened);
    expect(byId(findings, "openai.release.contract").status).toBe("satisfied");
  });

  it("classifies an outputSchema change the same way", () => {
    const deltas = compareOpenAISnapshots(
      snapshot(),
      snapshot({
        tools: [
          {
            name: "get_forecast",
            title: "Get forecast",
            description: "Look up a forecast",
            inputSchema: {
              type: "object",
              properties: { city: { type: "string" } },
            },
            outputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
        ],
      }),
    );
    expect(
      deltas.find((delta) => delta.subject.endsWith("outputSchema"))?.impact,
    ).toBe("unknown-compatibility");
  });
});

describe("live-compatible changes", () => {
  it("names the UI resources whose content may change without a review", () => {
    const findings = grade(snapshot(), snapshot());
    const live = byId(findings, "openai.release.live-changes");
    expect(live.status).toBe("informational");
    // Saying this is what stops a submitter filing a version for a CSS fix —
    // and the cache note is what stops "I deployed it and nothing changed"
    // becoming a bug report.
    expect(live.remediation).toContain("60 minutes");
    expect(live.class).toBe("experimental-feature");
  });

  it("does not call a resource live-compatible once its metadata moved", () => {
    const deltas = compareOpenAISnapshots(
      snapshot(),
      snapshot({
        uiResources: [
          {
            uri: "ui://weather/card",
            mimeType: "text/html;profile=mcp-app",
            domain: "other.weather.example.com",
            declaredCspDomains: ["cdn.example.com"],
          },
        ],
      }),
    );
    expect(
      deltas.filter((delta) => delta.impact === "live-compatible"),
    ).toEqual([]);
  });
});

describe("captureOpenAIMetadataSnapshot", () => {
  it("splits origin from path", () => {
    const captured = captureOpenAIMetadataSnapshot({
      endpointUrl: "https://plugin.example.com/api/mcp/",
    });
    // Stored apart because one is a new plugin and the other is a version bump.
    expect(captured.origin).toBe("https://plugin.example.com");
    expect(captured.path).toBe("/api/mcp");
  });

  it("keeps a malformed URL unequal to everything", () => {
    const captured = captureOpenAIMetadataSnapshot({
      endpointUrl: "not a url",
    });
    expect(captured.origin).toBe("not a url");
    expect(captured.path).toBe("");
  });
});
