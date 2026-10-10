import { describe, expect, it } from "vitest";
import {
  APP_ROUTE_WORDS,
  captureContextKey,
  decodeCaptureContext,
  encodeCaptureContext,
  MAX_TELEMETRY_CONTEXT_IDS,
  maskReplayAttribute,
  maskReplayText,
  mostRestrictivePolicy,
  scrubNamesFromUrl,
} from "../telemetry-privacy";
import { scrubSensitiveUrl } from "../credential-url";

const FULL = { recording: "full", identity: "full" } as const;
const MASKED = { recording: "masked", identity: "id_only" } as const;

describe("mostRestrictivePolicy", () => {
  it("takes the stricter value of each field", () => {
    expect(
      mostRestrictivePolicy(FULL, { recording: "masked", identity: "full" }),
    ).toEqual({ recording: "masked", identity: "full" });
    expect(
      mostRestrictivePolicy({ recording: "full", identity: "id_only" }, FULL),
    ).toEqual({ recording: "full", identity: "id_only" });
    expect(mostRestrictivePolicy(FULL, FULL)).toEqual(FULL);
  });

  it("treats nothing, null and malformed policies as conservative", () => {
    expect(mostRestrictivePolicy()).toEqual(MASKED);
    expect(mostRestrictivePolicy(FULL, null)).toEqual(MASKED);
    expect(mostRestrictivePolicy(FULL, { recording: "all" } as never)).toEqual(
      MASKED,
    );
  });
});

describe("capture-context stamps", () => {
  it("round-trips, deduplicated and sorted", () => {
    const stamp = encodeCaptureContext({
      projectIds: ["p2", "p1", "p1"],
      organizationIds: ["o1"],
      policy: FULL,
    });
    expect(stamp).toEqual({
      v: 1,
      p: ["p1", "p2"],
      o: ["o1"],
      r: "full",
      i: "full",
    });
    expect(decodeCaptureContext(stamp)).toEqual({
      projectIds: ["p1", "p2"],
      organizationIds: ["o1"],
      policy: FULL,
    });
  });

  it.each([
    ["missing", undefined],
    ["not an object", "full"],
    ["an unknown version", { v: 2, p: [], o: [], r: "full", i: "full" }],
    ["an unknown policy", { v: 1, p: [], o: [], r: "everything", i: "full" }],
    ["ids that are not strings", { v: 1, p: [1], o: [], r: "full", i: "full" }],
    [
      "too many ids",
      {
        v: 1,
        p: Array.from(
          { length: MAX_TELEMETRY_CONTEXT_IDS + 1 },
          (_, i) => `p${i}`,
        ),
        o: [],
        r: "full",
        i: "full",
      },
    ],
    [
      "an oversized id",
      { v: 1, p: ["x".repeat(65)], o: [], r: "full", i: "full" },
    ],
  ])("refuses a stamp that is %s", (_name, value) => {
    expect(decodeCaptureContext(value)).toBeNull();
  });

  it("keys contexts by their ids only", () => {
    expect(
      captureContextKey({ projectIds: ["b", "a"], organizationIds: ["o"] }),
    ).toBe(
      captureContextKey({ projectIds: ["a", "b"], organizationIds: ["o"] }),
    );
  });
});

describe("replay masking helpers", () => {
  it("masks every visible character and keeps whitespace", () => {
    expect(maskReplayText("Zelda Q\n1")).toBe("***** *\n*");
  });

  it("keeps layout attributes and masks the rest", () => {
    expect(maskReplayAttribute("class", "row")).toBe("row");
    expect(maskReplayAttribute("TITLE", "Zelda")).toBe("***");
    expect(maskReplayAttribute("data-state", "open")).toBe("open");
  });
});

describe("scrubNamesFromUrl", () => {
  it("keeps route words, ids and the credential sanitizer's placeholder", () => {
    expect(
      scrubNamesFromUrl(
        "https://app.mcpjam.com/p/kd7a8f9g0h1j2k3l4m5n6p7q8r/servers/acme-billing?q=zelda#x",
      ),
    ).toBe(
      "https://app.mcpjam.com/p/kd7a8f9g0h1j2k3l4m5n6p7q8r/servers/[name]?q=[name]",
    );
    expect(
      scrubNamesFromUrl(
        scrubSensitiveUrl("/results/kd7a8f9g0h1j2k3l4m5n6p7q8r9s"),
      ),
    ).toBe("/results/[redacted]");
  });

  it("is idempotent", () => {
    const once = scrubNamesFromUrl("/servers/acme/tools?x=y");
    expect(scrubNamesFromUrl(once)).toBe(once);
  });

  it("knows the API prefixes replayed network requests use", () => {
    for (const word of ["p", "api", "web", "v1", "mcp"]) {
      expect(APP_ROUTE_WORDS.has(word)).toBe(true);
    }
  });
});

describe("scrubNamesFromUrl hosts", () => {
  it("keeps MCPJam's own hosts and loopback, replaces any other", () => {
    expect(scrubNamesFromUrl("https://staging.mcpjam.com/servers")).toBe(
      "https://staging.mcpjam.com/servers",
    );
    expect(scrubNamesFromUrl("http://127.0.0.1:6274/servers")).toBe(
      "http://127.0.0.1:6274/servers",
    );
    expect(
      scrubNamesFromUrl("https://cdn.acme-synthetic.example/avatars/zelda.png"),
    ).toBe("https://[host]/[name]/[name]");
    expect(scrubNamesFromUrl("https://user:secret@acme.example/mcp")).toBe(
      "https://[host]/mcp",
    );
  });

  it("is idempotent once a host is replaced", () => {
    const once = scrubNamesFromUrl("https://acme.example/servers/zelda?x=1");
    expect(once).toBe("https://[host]/servers/[name]?x=1");
    expect(scrubNamesFromUrl(once)).toBe(once);
  });
});
