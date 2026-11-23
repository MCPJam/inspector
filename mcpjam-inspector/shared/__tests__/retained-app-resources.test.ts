import { describe, expect, it } from "vitest";
import {
  isRetainedResourceRefused,
  readRetainedResourceSource,
  RETAINED_RESOURCE_REFUSED,
  RETAINED_RESOURCE_SOURCE,
  withRetainedResourceSource,
} from "../retained-app-resources";

const source = {
  owner: {
    kind: "chat" as const,
    userId: "user",
    harnessSessionId: "lane",
    serverId: "server",
  },
  digest: "digest",
  projectId: "project",
  chatSessionId: "chat",
  version: 1 as const,
  profile: "profile",
  attestation: "attestation",
  toolCallId: "call",
};

describe("retained App markers", () => {
  it("marks a refused App only when the host says so", () => {
    const result = { content: [], _meta: { kept: true } };
    const refused = withRetainedResourceSource(result, undefined, true);
    expect(isRetainedResourceRefused(refused)).toBe(true);
    expect(refused).toMatchObject({ _meta: { kept: true } });
    expect(withRetainedResourceSource(result)).toBe(result);
  });

  it("drops either marker a server put in its own result", () => {
    const forged = {
      content: [],
      _meta: { [RETAINED_RESOURCE_SOURCE]: source, [RETAINED_RESOURCE_REFUSED]: true },
    };
    const cleaned = withRetainedResourceSource(forged);
    expect(isRetainedResourceRefused(cleaned)).toBe(false);
    expect(readRetainedResourceSource(cleaned)).toBeUndefined();
  });

  it("prefers a bound source over a refusal", () => {
    const bound = withRetainedResourceSource({ content: [] }, source, true);
    expect(readRetainedResourceSource(bound)).toEqual(source);
    expect(isRetainedResourceRefused(bound)).toBe(false);
  });
});
