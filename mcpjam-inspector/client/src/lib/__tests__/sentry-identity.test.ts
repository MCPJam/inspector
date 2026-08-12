import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSentryActor, setSentryOrganization } from "../sentry-identity";

const mocks = vi.hoisted(() => ({
  setUser: vi.fn(),
  setTag: vi.fn(),
}));

vi.mock("@sentry/react", () => ({
  setUser: mocks.setUser,
  setTag: mocks.setTag,
}));

describe("setSentryActor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("omits the email fields entirely for an actor without one", () => {
    // Not `email: undefined`: Sentry renders a user block from whatever keys
    // are present, and an explicit undefined is a key.
    setSentryActor({ kind: "guest", id: "guest-1" });

    expect(mocks.setUser).toHaveBeenCalledWith({ id: "guest-1" });
    expect(mocks.setTag).toHaveBeenCalledWith("actor_kind", "guest");
  });

  it("mirrors the email into username so the issue list shows a person", () => {
    setSentryActor({
      kind: "signedIn",
      id: "workos-1",
      email: "someone@example.com",
    });

    expect(mocks.setUser).toHaveBeenCalledWith({
      id: "workos-1",
      email: "someone@example.com",
      username: "someone@example.com",
    });
  });

  it("clears the actor tag along with the user", () => {
    // A cleared user with a surviving `actor_kind` would attribute the next
    // anonymous event to the population the previous actor belonged to.
    setSentryActor(null);

    expect(mocks.setUser).toHaveBeenCalledWith(null);
    expect(mocks.setTag).toHaveBeenCalledWith("actor_kind", undefined);
  });
});

describe("setSentryOrganization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["the empty string", ""],
    ["whitespace", "   "],
  ])("clears the tag for %s", (_label, orgId) => {
    setSentryOrganization(orgId);

    expect(mocks.setTag).toHaveBeenCalledWith("organization_id", undefined);
  });

  it("tags the active org", () => {
    setSentryOrganization("org_123");

    expect(mocks.setTag).toHaveBeenCalledWith("organization_id", "org_123");
  });
});
