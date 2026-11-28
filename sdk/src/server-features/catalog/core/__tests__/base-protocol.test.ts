import { describe, expect, it } from "vitest";
import {
  fullCoverage,
  makeProbe,
  makeSurface,
} from "../../../__tests__/fixtures.js";
import { CORE_FEATURES } from "../index.js";
import { declared, isGap, kindOf, probed } from "./helpers.js";

describe("server information", () => {
  it("reads name, version and title from serverInfo", () => {
    const surface = makeSurface({
      serverInfo: { name: "weather", version: "1.2.0", title: "Weather" },
    });
    expect(kindOf(declared("server-info.name-version", surface))).toBe(
      "present"
    );
    expect(kindOf(declared("server-info.title", surface))).toBe("present");
  });

  it("calls a missing field a gap only when serverInfo was captured", () => {
    const complete = makeSurface();
    expect(isGap(declared("server-info.icons", complete), complete)).toBe(true);
    expect(
      isGap(declared("server-info.instructions", complete), complete)
    ).toBe(true);

    const dropped = makeSurface({
      coverage: fullCoverage({
        serverInfo: "not-captured",
        instructions: "partial",
      }),
    });
    expect(isGap(declared("server-info.icons", dropped), dropped)).toBe(false);
    expect(isGap(declared("server-info.instructions", dropped), dropped)).toBe(
      false
    );
  });

  it("treats a missing name or version as absent, not supported", () => {
    const surface = makeSurface({ serverInfo: { name: "weather" } });
    expect(kindOf(declared("server-info.name-version", surface))).toBe(
      "absent"
    );
  });

  it("lists experimental capabilities and is not applicable without any", () => {
    const withKeys = makeSurface({
      capabilities: { experimental: { "acme/search": {} } },
    });
    expect(declared("server-info.experimental", withKeys)).toMatchObject({
      kind: "present",
      count: 1,
      detail: "acme/search",
    });
    expect(kindOf(declared("server-info.experimental", makeSurface()))).toBe(
      "not-applicable"
    );
    const partial = makeSurface({
      coverage: fullCoverage({ capabilities: "partial" }),
    });
    expect(isGap(declared("server-info.experimental", partial), partial)).toBe(
      false
    );
  });

  it("detects serverInfo in the discover result's _meta", () => {
    const surface = makeSurface({
      protocolVersion: "2026-07-28",
      discoveryMeta: {
        "io.modelcontextprotocol/serverInfo": { name: "weather", version: "1" },
      },
    });
    expect(kindOf(declared("server-info.result-server-info", surface))).toBe(
      "present"
    );
    expect(
      declared("server-info.result-server-info", makeSurface())
    ).toBeNull();
  });
});

describe("lifecycle and discovery", () => {
  it("shows initialize on 2025 revisions and leaves 2026 to the lifecycle", () => {
    expect(
      kindOf(
        declared(
          "lifecycle.initialize",
          makeSurface({ protocolVersion: "2025-06-18" })
        )
      )
    ).toBe("present");
    expect(
      declared(
        "lifecycle.initialize",
        makeSurface({ protocolVersion: "2026-07-28" })
      )
    ).toBeNull();
  });

  it("does not borrow current rules for an unknown future revision", () => {
    const future = makeSurface({ protocolVersion: "2027-07-28" });
    expect(kindOf(declared("lifecycle.initialize", future))).toBe("unknown");
    expect(kindOf(declared("lifecycle.extensions", future))).toBe("unknown");
    expect(declared("lifecycle.server-discover", future)).toBeNull();
  });

  it("reads server/discover and supportedVersions on 2026-07-28", () => {
    const modern = makeSurface({
      protocolVersion: "2026-07-28",
      supportedVersions: ["2025-11-25", "2026-07-28"],
    });
    expect(kindOf(declared("lifecycle.server-discover", modern))).toBe(
      "present"
    );
    expect(declared("lifecycle.supported-versions", modern)).toMatchObject({
      kind: "present",
      count: 2,
    });

    const notCaptured = makeSurface({
      protocolVersion: "2026-07-28",
      coverage: fullCoverage({ capabilities: "not-captured" }),
    });
    expect(kindOf(declared("lifecycle.server-discover", notCaptured))).toBe(
      "unknown"
    );
    expect(kindOf(declared("lifecycle.supported-versions", notCaptured))).toBe(
      "unknown"
    );
  });

  it("never reads a missing extensions map on a 2025 server as a gap", () => {
    const legacy = makeSurface({ protocolVersion: "2025-11-25" });
    expect(kindOf(declared("lifecycle.extensions", legacy))).toBe("unknown");

    const modern = makeSurface({ protocolVersion: "2026-07-28" });
    expect(kindOf(declared("lifecycle.extensions", modern))).toBe(
      "not-applicable"
    );

    const declaredOnLegacy = makeSurface({
      protocolVersion: "2025-11-25",
      capabilities: { extensions: { "io.modelcontextprotocol/ui": {} } },
    });
    expect(kindOf(declared("lifecycle.extensions", declaredOnLegacy))).toBe(
      "present"
    );
  });
});

describe("transports", () => {
  const stdio = makeSurface({ transport: "stdio" });
  const http = makeSurface({
    transport: "streamable-http",
    protocolVersion: "2025-11-25",
  });

  it("knows the configured transport and marks the others not applicable", () => {
    expect(kindOf(declared("transport.stdio", stdio))).toBe("present");
    expect(kindOf(declared("transport.streamable-http", stdio))).toBe(
      "not-applicable"
    );
    expect(kindOf(declared("transport.http-sse", stdio))).toBe(
      "not-applicable"
    );
    expect(kindOf(declared("transport.stdio", http))).toBe("not-applicable");
    expect(kindOf(declared("transport.streamable-http", http))).toBe("present");
    expect(declared("transport.streamable-http-stateless", http)).toBeNull();
    expect(
      kindOf(
        declared(
          "transport.streamable-http-stateless",
          makeSurface({ protocolVersion: "2026-07-28" })
        )
      )
    ).toBe("present");
  });

  it("reads HTTP+SSE from the transport probe", () => {
    const offered = {
      "http-transport": makeProbe("http-transport", { legacySse: true }),
    };
    expect(kindOf(probed("transport.http-sse", offered))).toBe("present");

    const none = {
      "http-transport": makeProbe("http-transport", { legacySse: false }),
    };
    expect(isGap(probed("transport.http-sse", none), makeSurface())).toBe(true);

    const partial = {
      "http-transport": makeProbe(
        "http-transport",
        { legacySse: false },
        { coverage: "partial" }
      ),
    };
    expect(kindOf(probed("transport.http-sse", partial))).toBe("unknown");

    const failed = {
      "http-transport": makeProbe("http-transport", {}, { status: "failed" }),
    };
    expect(kindOf(probed("transport.http-sse", failed))).toBe("unknown");
    expect(probed("transport.http-sse", {})).toBeNull();
  });
});

describe("transport behavior", () => {
  const behavior = CORE_FEATURES.filter(
    (entry) =>
      entry.family === "transport-behavior" &&
      entry.id !== "transport-behavior.stdio-discover-shutdown"
  );

  it("is not applicable on stdio servers", () => {
    const stdio = makeSurface({ transport: "stdio" });
    expect(behavior.length).toBeGreaterThan(10);
    for (const entry of behavior) {
      expect(kindOf(entry.assessment.declared?.(stdio) ?? null), entry.id).toBe(
        "not-applicable"
      );
    }
    expect(
      kindOf(
        declared("transport-behavior.stdio-discover-shutdown", makeSurface())
      )
    ).toBe("not-applicable");
    expect(
      kindOf(
        declared(
          "transport-behavior.stdio-discover-shutdown",
          makeSurface({ transport: "stdio", protocolVersion: "2026-07-28" })
        )
      )
    ).toBe("present");
  });

  it("reads sessions per revision from the transport probe", () => {
    const legacyIssued = {
      "http-transport": makeProbe("http-transport", {
        protocolVersion: "2025-11-25",
        sessionIdIssued: true,
      }),
    };
    expect(kindOf(probed("transport-behavior.session-id", legacyIssued))).toBe(
      "present"
    );

    const legacyNone = {
      "http-transport": makeProbe("http-transport", {
        protocolVersion: "2025-11-25",
        sessionIdIssued: false,
      }),
    };
    expect(kindOf(probed("transport-behavior.session-id", legacyNone))).toBe(
      "absent"
    );
    expect(
      probed("transport-behavior.stateless-sessions", legacyNone)
    ).toBeNull();

    const modernNone = {
      "http-transport": makeProbe("http-transport", {
        protocolVersion: "2026-07-28",
        sessionIdIssued: false,
      }),
    };
    expect(
      kindOf(probed("transport-behavior.stateless-sessions", modernNone))
    ).toBe("present");
    expect(probed("transport-behavior.session-id", modernNone)).toBeNull();

    const modernMinted = {
      "http-transport": makeProbe("http-transport", {
        protocolVersion: "2026-07-28",
        sessionIdIssued: true,
      }),
    };
    expect(
      kindOf(probed("transport-behavior.stateless-sessions", modernMinted))
    ).toBe("absent");
  });

  it("reads the response mode the probe saw", () => {
    const sse = {
      "http-transport": makeProbe("http-transport", {
        responseContentType: "text/event-stream",
      }),
    };
    expect(probed("transport-behavior.response-mode", sse)).toMatchObject({
      kind: "present",
      detail: "Answers with an event stream.",
    });
    const odd = {
      "http-transport": makeProbe("http-transport", {
        responseContentType: "text/html",
      }),
    };
    expect(probed("transport-behavior.response-mode", odd)).toBeNull();
  });

  it("finds x-mcp-header anywhere in a tool's input schema", () => {
    const withHeader = makeSurface({
      tools: [
        {
          name: "search",
          inputSchema: {
            type: "object",
            properties: {
              region: { type: "string", "x-mcp-header": "Region" },
            },
          },
        },
        { name: "ping", inputSchema: { type: "object" } },
      ],
    });
    expect(
      declared("transport-behavior.x-mcp-header", withHeader)
    ).toMatchObject({
      kind: "present",
      count: 1,
    });

    const without = makeSurface({
      tools: [{ name: "ping", inputSchema: { type: "object" } }],
    });
    expect(
      isGap(declared("transport-behavior.x-mcp-header", without), without)
    ).toBe(true);

    const lossy = makeSurface({
      tools: [{ name: "ping", inputSchema: { type: "object" } }],
      coverage: fullCoverage({ toolSchemas: "partial" }),
    });
    expect(
      isGap(declared("transport-behavior.x-mcp-header", lossy), lossy)
    ).toBe(false);
  });
});
