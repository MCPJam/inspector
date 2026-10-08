import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopSentryFallback,
  setSentryActor,
  setSentryOrganization,
} from "../sentry-identity";

afterEach(() => {
  delete window.electronAPI;
});

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

  it("sends only ID and kind to Electron and restores installation identity on sign-out", () => {
    const setActor = vi.fn();
    window.electronAPI = {
      sentry: { installationId: "installation:test", setActor },
    } as never;
    setSentryActor({
      kind: "signedIn",
      id: "user_A",
      email: "private@example.com",
      name: "Private",
    });
    expect(setActor).toHaveBeenLastCalledWith({
      id: "user_A",
      kind: "signedIn",
    });
    setSentryActor({ kind: "guest", id: "guest_A" });
    expect(setActor).toHaveBeenLastCalledWith({ id: "guest_A", kind: "guest" });
    setSentryActor(null);
    expect(setActor).toHaveBeenLastCalledWith(null);
    expect(mocks.setUser).toHaveBeenLastCalledWith({ id: "installation:test" });
    expect(mocks.setTag).toHaveBeenLastCalledWith("actor_kind", "installation");
  });

  it("continues setting frontend identity if the desktop bridge fails", () => {
    window.electronAPI = {
      sentry: {
        installationId: "installation:test",
        setActor: () => {
          throw new Error("bridge unavailable");
        },
      },
    } as never;
    expect(() =>
      setSentryActor({ kind: "guest", id: "guest_A" }),
    ).not.toThrow();
    expect(mocks.setUser).toHaveBeenLastCalledWith({ id: "guest_A" });
  });

  it("does not use a malformed installation identifier", () => {
    window.electronAPI = {
      sentry: {
        installationId: "installation:private@example.com",
        setActor: vi.fn(),
      },
    } as never;
    expect(desktopSentryFallback()).toBeUndefined();
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
