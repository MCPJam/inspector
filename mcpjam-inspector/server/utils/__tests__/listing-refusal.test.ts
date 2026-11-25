import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  SERVER_REFUSAL_MAX_CHARS,
  serverRefusalText,
  snapshotCaptureError,
} from "../listing-refusal.js";

describe("serverRefusalText", () => {
  it("reads a server's answer from a ProtocolError or from the worded string", () => {
    const text = 'The mock edits "echo", which the real server no longer lists.';
    expect(serverRefusalText(new ProtocolError(ProtocolErrorCode.InvalidParams, text))).toBe(text);
    expect(serverRefusalText(new Error(`MCP error -32602: ${text}`))).toBe(text);
  });

  it("says nothing for a failure that is not a server's answer, and caps a long one", () => {
    expect(serverRefusalText(new Error("fetch failed"))).toBeUndefined();
    expect(serverRefusalText("MCP error -1: x")).toBeUndefined();
    const long = serverRefusalText(new ProtocolError(ProtocolErrorCode.InvalidParams, "x".repeat(900)));
    expect(long).toHaveLength(SERVER_REFUSAL_MAX_CHARS);
  });

  it("keeps a refusal readable back after the snapshot stores it as a string", () => {
    const stored = snapshotCaptureError(
      new ProtocolError(ProtocolErrorCode.InvalidParams, 'The mock edits "echo".'),
    );
    expect(serverRefusalText(new Error(stored))).toBe('The mock edits "echo".');
    expect(snapshotCaptureError(new Error("fetch failed"))).toBe("fetch failed");
  });
});
