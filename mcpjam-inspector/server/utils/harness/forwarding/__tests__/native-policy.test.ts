import { expect, it } from "vitest";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import {
  nativePolicyDigest,
  stampNativeForwardingPolicy,
} from "../native-policy";

it("pins every tool-policy decision while tolerating harmless key order", () => {
  const policy: ToolPolicySnapshot = {
    mode: "default",
    known: ["read", "write"],
    denied: {},
    unknownTool: "allow",
  };
  const digest = nativePolicyDigest({ server: policy });
  expect(
    nativePolicyDigest({ server: { ...policy, known: ["write", "read"] } }),
  ).toBe(digest);
  expect(
    nativePolicyDigest({ server: { ...policy, mode: "readOnly" } }),
  ).not.toBe(digest);
  expect(
    nativePolicyDigest({ server: { ...policy, unknownTool: "deny" } }),
  ).not.toBe(digest);
  expect(
    nativePolicyDigest({ server: { ...policy, known: ["read"] } }),
  ).not.toBe(digest);
  expect(nativePolicyDigest({ other: policy })).not.toBe(digest);
  expect(
    stampNativeForwardingPolicy({ data: { bridge: "original" } }, digest),
  ).toEqual({
    data: { bridge: "original", mcpjamForwardingPolicy: digest },
  });
});
