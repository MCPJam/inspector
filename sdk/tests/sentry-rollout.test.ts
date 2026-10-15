import { describe, expect, it } from "vitest";
import { rebuildSentryEvent } from "../src/internal/telemetry.js";

const options = {
  files: ["server/one.ts", "server/two.ts"],
  messages: ["process.uncaught_exception", "Known diagnostic"],
  diagnosticFields: { code: ["INTERNAL_ERROR", "TIMEOUT"] },
};
const event = (file: string, line: number, code = "INTERNAL_ERROR") => ({
  extra: { errorCode: code, customer: "PRIVATE_SENTINEL" },
  exception: {
    values: [
      {
        type: "Error",
        stacktrace: {
          frames: [
            { filename: file, lineno: line, function: "PRIVATE_SENTINEL" },
          ],
        },
      },
    ],
  },
});

describe("diagnostic grouping during rollout", () => {
  it("separates errors by approved code but not by build-specific frame positions", () => {
    const first = rebuildSentryEvent(event("server/one.ts", 7), options);
    const second = rebuildSentryEvent(event("server/two.ts", 9), options);
    const fingerprint = ["{{ default }}", "Error", "INTERNAL_ERROR"];
    expect(first).toMatchObject({
      fingerprint,
      exception: {
        values: [
          {
            stacktrace: { frames: [{ filename: "server/one.ts", lineno: 7 }] },
          },
        ],
      },
    });
    expect(second).toMatchObject({ fingerprint });
    expect(
      rebuildSentryEvent(event("server/one.ts", 7, "TIMEOUT"), options)
    ).toMatchObject({ fingerprint: ["{{ default }}", "Error", "TIMEOUT"] });
    expect(JSON.stringify(first)).not.toContain("PRIVATE_SENTINEL");
    const untrusted = rebuildSentryEvent(
      event("/customer/server/one.ts", 7, "PRIVATE_SENTINEL"),
      options
    );
    expect(untrusted).toMatchObject({
      fingerprint: ["{{ default }}", "Error"],
    });
    expect(JSON.stringify(untrusted)).not.toContain("PRIVATE_SENTINEL");
  });

  it("retains only catalogued event names and static messages", () => {
    for (const message of options.messages)
      expect(rebuildSentryEvent({ message }, options)).toMatchObject({
        message,
        fingerprint: [message],
      });
    expect(
      rebuildSentryEvent({ message: "PRIVATE_SENTINEL" }, options)
    ).toMatchObject({ message: "telemetry_event" });
  });

  it("rebuilds debug metadata from build-owned IDs only", () => {
    const input = {
      ...event("server/one.ts", 7),
      debug_meta: { images: [{ code_file: "PRIVATE_SENTINEL" }] },
    };
    const output = rebuildSentryEvent(input, {
      ...options,
      environment: "prod",
      platform: "node",
      frameOutputNames: { "server/one.ts": "app:///server/one.ts" },
      frameDebugIds: {
        "app:///server/one.ts": "01234567-89ab-cdef-0123-456789abcdef",
      },
    });
    expect(output).toMatchObject({
      environment: "prod",
      platform: "node",
      debug_meta: {
        images: [
          {
            type: "sourcemap",
            code_file: "app:///server/one.ts",
            debug_id: "01234567-89ab-cdef-0123-456789abcdef",
          },
        ],
      },
    });
    expect(JSON.stringify(output)).not.toContain("PRIVATE_SENTINEL");
  });
});
