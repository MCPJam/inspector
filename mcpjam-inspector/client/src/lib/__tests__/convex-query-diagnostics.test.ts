import { beforeEach, describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/react";
import { ConvexError } from "convex/values";
import {
  configureConvexQueryDiagnostics,
  createConvexQueryEventProcessor,
  queryFailureDetails,
  queryPageLocation,
  safeQueryError,
} from "../convex-query-diagnostics";

const message =
  "[CONVEX Q(chatboxes:listChatboxes)] [Request ID: deadbeef1234] Server Error\nArguments: { token: 'SECRET' }\nCalled by client";
const event = (value = message): ErrorEvent => ({
  exception: {
    values: [
      {
        type: "Error",
        value,
        stacktrace: {
          frames: [
            {
              filename: "app.js",
              function: "useQuery",
              vars: { token: "SECRET" },
            },
          ],
        },
      },
    ],
  },
  release: "3.11.0",
  dist: "web",
  user: { id: "test-user" },
  fingerprint: ["existing-group"],
  tags: { source: "route_error_element" },
  request: {
    url: "https://app.mcpjam.com/results/SECRET?token=SECRET#SECRET",
    headers: { Authorization: "SECRET" },
  },
  breadcrumbs: [{ message: "SECRET" }],
  extra: { args: { token: "SECRET" }, boundary: "route" },
});

describe("Convex query diagnostics", () => {
  beforeEach(() =>
    configureConvexQueryDiagnostics("https://example.convex.cloud"),
  );
  it("extracts correlation while retaining build, identity, grouping and frames", () => {
    const result = createConvexQueryEventProcessor()(event())!;
    expect(result.tags).toEqual({
      source: "route_error_element",
      convex_function: "chatboxes:listChatboxes",
      request_id: "deadbeef1234",
      convex_backend: "example.convex.cloud",
    });
    expect(result.release).toBe("3.11.0");
    expect(result.dist).toBe("web");
    expect(result.user).toEqual({ id: "test-user" });
    expect(result.fingerprint).toEqual(["existing-group"]);
    expect(result.extra).toEqual({
      boundary: "route",
      page_location: "https://app.mcpjam.com/results/[redacted]",
    });
    expect(result.exception!.values![0].stacktrace!.frames![0].function).toBe(
      "useQuery",
    );
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("deduplicates subscription, boundary and global events by host and request", () => {
    const process = createConvexQueryEventProcessor();
    expect(process(event())).not.toBeNull();
    expect(
      process(event(), { originalException: new Error(message) }),
    ).toBeNull();
    configureConvexQueryDiagnostics("https://other.convex.cloud");
    expect(process(event())).not.toBeNull();
    expect(
      process(event(message.replace("deadbeef1234", "ab1234"))),
    ).not.toBeNull();
  });
  it("bounds the cache and does not merge failures without request IDs", () => {
    const process = createConvexQueryEventProcessor(2);
    for (const id of ["aa", "bb", "cc", "aa"])
      expect(
        process(event(message.replace("deadbeef1234", id))),
      ).not.toBeNull();
    const noId = "[CONVEX Q(scenarios:listScenarios)] Query failed";
    expect(process(event(noId))).not.toBeNull();
    expect(process(event(noId))).not.toBeNull();
    expect(process(event(noId))!.tags).not.toHaveProperty("request_id");
  });
  it("preserves unrelated events and ignores malformed prefixes", () => {
    const other = event("Something else failed");
    expect(createConvexQueryEventProcessor()(other)).toBe(other);
    expect(other.extra).toHaveProperty("args");
    expect(
      queryFailureDetails("[CONVEX M(scenarios:create)] Server Error"),
    ).toBeUndefined();
    expect(
      queryFailureDetails("[CONVEX Q(token?secret)] Error"),
    ).toBeUndefined();
  });
  it("keeps authorization refusals quiet without consuming the request ID", () => {
    const process = createConvexQueryEventProcessor();
    expect(
      process(event(), {
        originalException: new ConvexError({ kind: "forbidden" }),
      }),
    ).toBeNull();
    expect(process(event())).not.toBeNull();
  });
  it("sanitizes errors before either telemetry sink sees them", () => {
    const original = new Error(message);
    const safe = safeQueryError(original);
    expect(safe.message).toBe(
      "[CONVEX Q(chatboxes:listChatboxes)] [Request ID: deadbeef1234] Server Error",
    );
    expect(safe.stack).not.toContain("SECRET");
    expect(original.message).toContain("SECRET");
    expect(
      safeQueryError(new Error("[CONVEX Q(a:b)] Validator rejected SECRET"))
        .message,
    ).not.toContain("SECRET");
  });
  it.each([
    "/results/SECRET",
    "/conformance/shared/SECRET",
    "/evals/shared/SECRET",
    "/user-testing/slug/SECRET",
    "/chatbox/slug/SECRET",
    "/organizations/SECRET",
  ])("redacts %s", (path) => {
    expect(
      queryPageLocation(`https://app.mcpjam.com${path}?secret=SECRET#SECRET`),
    ).not.toContain("SECRET");
  });
  it("drops credentials in URL authority and rejects invalid or file URLs", () => {
    expect(
      queryPageLocation("https://user:SECRET@app.mcpjam.com/playground"),
    ).toBe("https://app.mcpjam.com/playground");
    expect(queryPageLocation("file:///private/SECRET")).toBeUndefined();
    expect(queryPageLocation("invalid")).toBeUndefined();
  });
});
