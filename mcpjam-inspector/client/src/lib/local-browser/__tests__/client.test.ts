/**
 * What is specific to the LOCAL browser client.
 *
 * The pointer mapping and the input forwarder moved to
 * `lib/browser-pane/__tests__/input.test.ts` with the code they cover — they
 * are not local-engine behaviour. This is.
 */
import { describe, expect, it } from "vitest";
import { isSecureLocalOrigin } from "../client";

describe("where the consent token may be sent", () => {
  it("accepts loopback over http and anything over https", () => {
    expect(
      isSecureLocalOrigin({ protocol: "http:", hostname: "localhost" }),
    ).toBe(true);
    expect(
      isSecureLocalOrigin({ protocol: "http:", hostname: "127.0.0.1" }),
    ).toBe(true);
    expect(
      isSecureLocalOrigin({
        protocol: "https:",
        hostname: "inspector.example",
      }),
    ).toBe(true);
  });

  it("refuses a plaintext hop to another machine", () => {
    // The routes only exist on a local inspector, but the PAGE can be served
    // from anywhere — and then the consent token and every keystroke this pane
    // forwards cross a hop anyone on the path can read.
    expect(
      isSecureLocalOrigin({ protocol: "http:", hostname: "192.168.1.20" }),
    ).toBe(false);
    expect(
      isSecureLocalOrigin({ protocol: "http:", hostname: "inspector.local" }),
    ).toBe(false);
  });
});
