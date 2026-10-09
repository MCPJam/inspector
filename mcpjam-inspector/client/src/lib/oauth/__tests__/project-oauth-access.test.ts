import { describe, expect, it } from "vitest";
import { checkProjectOAuthAccess } from "../project-oauth-access";
import type { HostedOAuthCallbackContext } from "../../hosted-oauth-callback";

const context: HostedOAuthCallbackContext = {
  surface: "project",
  initiatingUserId: "original",
  projectId: "pinned",
  serverName: "server",
  serverUrl: "https://example.com/mcp",
  returnPath: "/servers",
  startedAt: 1,
};
const auth = {
  loading: false,
  userId: "original",
  projectIds: new Set(["pinned"]),
};
describe("project OAuth identity and access", () => {
  it("waits for auth and memberships", () => {
    expect(checkProjectOAuthAccess(context, { ...auth, loading: true })).toBe(
      "wait",
    );
    expect(
      checkProjectOAuthAccess(context, { ...auth, projectIds: undefined }),
    ).toBe("wait");
  });
  it("does not substitute a guest or different signed-in user", () => {
    expect(checkProjectOAuthAccess(context, { ...auth, userId: null })).toBe(
      "identity",
    );
    expect(checkProjectOAuthAccess(context, { ...auth, userId: "other" })).toBe(
      "identity",
    );
  });
  it("separates missing membership from lost identity", () => {
    expect(
      checkProjectOAuthAccess(context, { ...auth, projectIds: new Set() }),
    ).toBe("membership");
    expect(checkProjectOAuthAccess(context, auth)).toBe("allow");
  });
  it("requires legacy attempts to restart and permits explicit guests with access", () => {
    expect(
      checkProjectOAuthAccess(
        { ...context, initiatingUserId: undefined },
        auth,
      ),
    ).toBe("legacy");
    expect(
      checkProjectOAuthAccess(
        { ...context, initiatingUserId: null },
        { ...auth, userId: null },
      ),
    ).toBe("allow");
  });
});
