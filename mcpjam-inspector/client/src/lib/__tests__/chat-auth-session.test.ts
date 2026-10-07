import { describe, expect, it } from "vitest";
import { sameChatAuthSession } from "../chat-auth-session";
const claims = {
  iss: "https://auth.example",
  sub: "disposable-user",
  org_id: "disposable-org",
  role: "member",
  exp: 100,
  iat: 1,
  jti: "first",
};
const token = (value: Record<string, unknown>) =>
  `Bearer e30.${btoa(JSON.stringify(value)).replaceAll("=", "")}.signature`;
const headers = (value: Record<string, unknown>) => ({
  Authorization: token(value),
});
describe("chat continuity across credential refresh", () => {
  it("preserves only timestamp and nonce rotation, while using fresh credential bytes", () => {
    const a = headers(claims),
      b = headers({ ...claims, exp: 200, iat: 101, jti: "second" });
    expect(a.Authorization).not.toBe(b.Authorization);
    expect(sameChatAuthSession(a, b)).toBe(true);
  });
  it.each(["iss", "sub", "org_id", "role"])("resets when %s changes", (key) => {
    expect(
      sameChatAuthSession(
        headers(claims),
        headers({ ...claims, [key]: "changed" }),
      ),
    ).toBe(false);
  });
  it("resets on additional permissions, audience, or any other request header change", () => {
    expect(
      sameChatAuthSession(
        headers(claims),
        headers({ ...claims, permissions: ["admin"] }),
      ),
    ).toBe(false);
    expect(
      sameChatAuthSession(
        headers(claims),
        headers({ ...claims, aud: "other" }),
      ),
    ).toBe(false);
    expect(
      sameChatAuthSession(
        { ...headers(claims), "X-Scope": "one" },
        { ...headers(claims), "X-Scope": "two" },
      ),
    ).toBe(false);
  });
  it("keeps opaque keys and malformed, oversized, missing or signed-out credentials conservative", () => {
    expect(
      sameChatAuthSession(
        { Authorization: "Bearer api-key" },
        { Authorization: "Bearer different" },
      ),
    ).toBe(false);
    expect(
      sameChatAuthSession(
        headers(claims),
        headers({ ...claims, sub: undefined }),
      ),
    ).toBe(false);
    expect(
      sameChatAuthSession(headers(claims), {
        Authorization: "Bearer " + "x".repeat(20_000),
      }),
    ).toBe(false);
    expect(sameChatAuthSession(headers(claims), undefined)).toBe(false);
    expect(sameChatAuthSession(undefined, undefined)).toBe(true);
    expect(
      sameChatAuthSession(
        { Authorization: "Bearer api-key" },
        { Authorization: "Bearer api-key" },
      ),
    ).toBe(true);
  });
});
