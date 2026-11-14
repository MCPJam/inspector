import { describe, expect, it } from "vitest";
import {
  LOCAL_MRTR_PROTOCOL,
  localMrtrCredential,
  localMrtrProtocols,
  localMrtrResponseSchema,
} from "../local-mrtr-wire";
import { redactSecretShapes } from "../secret-shape-redaction";
import { scrubLogPayload, scrubLogText } from "../log-scrubber";

const token = "a-valid-local-session-token-0123456789";

describe("local form socket authentication", () => {
  it("offers only the public protocol first and reads the credential separately", () => {
    const protocols = localMrtrProtocols(token);
    expect(protocols[0]).toBe(LOCAL_MRTR_PROTOCOL);
    expect(localMrtrCredential(protocols.join(", "))).toBe(token);
  });

  it.each([
    undefined,
    "",
    LOCAL_MRTR_PROTOCOL,
    `mcpjam-session.${token}, ${LOCAL_MRTR_PROTOCOL}`,
    `${LOCAL_MRTR_PROTOCOL}, mcpjam-session.short`,
    `${LOCAL_MRTR_PROTOCOL}, mcpjam-session.${token}, extra`,
  ])("rejects missing, reordered, or malformed protocols: %s", (value) => {
    expect(localMrtrCredential(value)).toBeNull();
  });

  it("scrubs both header structures and credential-shaped free text", () => {
    const credential = localMrtrProtocols(token)[1];
    expect(
      JSON.stringify(scrubLogPayload({ "Sec-WebSocket-Protocol": credential })),
    ).not.toContain(token);
    expect(scrubLogText(`Handshake ${credential}`)).not.toContain(token);
    expect(redactSecretShapes(`Handshake ${credential}`)).not.toContain(token);
    expect(redactSecretShapes(LOCAL_MRTR_PROTOCOL)).toBe(LOCAL_MRTR_PROTOCOL);
  });

  it.each(["x".repeat(23) + "-", "-".repeat(24)])(
    "scrubs configured tokens ending in a non-word character",
    (value) => {
      const credential = localMrtrProtocols(value)[1];
      expect(
        JSON.stringify(
          scrubLogPayload({ "Sec-WebSocket-Protocol": credential }),
        ),
      ).not.toContain(value);
      expect(scrubLogText(`Handshake ${credential}`)).not.toContain(value);
      expect(redactSecretShapes(`Handshake ${credential}`)).not.toContain(
        value,
      );
    },
  );

  it("preserves arbitrary own response and content keys without prototype mutation", () => {
    const responses: unknown = JSON.parse(
      '{"__proto__":{"action":"accept","content":{"__proto__":"value"}},"constructor":{"action":"cancel"}}',
    );
    const parsed = localMrtrResponseSchema.parse({
      type: "respond",
      requestId: "1",
      opId: "op",
      roundKey: "op:1",
      responses,
    });
    expect(Object.keys(parsed.responses)).toEqual(["__proto__", "constructor"]);
    expect(Object.keys(parsed.responses["__proto__"].content ?? {})).toEqual([
      "__proto__",
    ]);
    expect(Object.getPrototypeOf(parsed.responses)).toBe(Object.prototype);
  });

  it("validates response actions before the collector can see them", () => {
    expect(
      localMrtrResponseSchema.safeParse({
        type: "respond",
        requestId: "1",
        opId: "op",
        roundKey: "op:1",
        responses: { q: { action: "delete" } },
      }).success,
    ).toBe(false);
    expect(
      localMrtrResponseSchema.safeParse({
        type: "respond",
        requestId: "1",
        opId: "op",
        roundKey: "op:1",
        responses: { q: { action: "cancel" } },
      }).success,
    ).toBe(true);
  });
});
