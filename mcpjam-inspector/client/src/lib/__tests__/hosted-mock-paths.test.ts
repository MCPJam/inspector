import { describe, expect, it } from "vitest";
import { HOSTED_MOCK_AUTH_PATH_PATTERNS } from "../hosted-mock-paths";

const matches = (path: string) => HOSTED_MOCK_AUTH_PATH_PATTERNS.some((p) => p.test(path));

describe("the hosted bearer allowlist for mock servers", () => {
  it.each([
    "/api/v1/projects/p1/mock-servers",
    "/api/v1/projects/p1/mock-servers/m1",
    "/api/v1/projects/p1/mock-servers/m1/versions",
    "/api/v1/projects/p1/mock-servers/m1/forwarding-policy",
    "/api/v1/projects/p1/mock-forwarding-policy",
  ])("sends the bearer to %s", (path) => expect(matches(path)).toBe(true));

  it.each([
    "/api/v1/projects/p1/mock-servers/m1/other",
    "/api/v1/projects/p1/mock-servers/m1/versions/2/extra",
    "/api/v1/projects/p1/mock-serversX",
  ])("does not send it to %s", (path) => expect(matches(path)).toBe(false));
});
