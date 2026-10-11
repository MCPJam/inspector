import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopSentryFallback,
  filterSentryEventIdentity,
  setSentryActor,
  setSentryOrganization,
} from "../sentry-identity";
import {
  resetTelemetryIdentity,
  setTelemetryActor,
  setTelemetryIdentity,
} from "../telemetry-context";

afterEach(() => {
  delete window.electronAPI;
  setTelemetryActor(null);
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

  it("starts id-only: no email or name before the backend clears this actor", () => {
    setSentryActor({
      kind: "signedIn",
      id: "workos-1",
      email: "someone@example.com",
      name: "Some One",
    });

    expect(mocks.setUser).toHaveBeenLastCalledWith({ id: "workos-1" });
  });

  it("mirrors the email into username so the issue list shows a person", () => {
    setTelemetryActor("workos-1");
    setTelemetryIdentity("workos-1", "full");
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

describe("the identity grant", () => {
  const member = {
    kind: "signedIn" as const,
    id: "workos-1",
    email: "someone@example.com",
    name: "Some One",
  };
  const named = {
    id: "workos-1",
    email: "someone@example.com",
    username: "someone@example.com",
    name: "Some One",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setTelemetryActor("workos-1");
  });

  afterEach(() => {
    setSentryActor(null);
  });

  it("names the actor once the backend answers full for them, and unnames at once when the grant goes", () => {
    setSentryActor(member);
    expect(mocks.setUser).toHaveBeenLastCalledWith({ id: "workos-1" });

    setTelemetryIdentity("workos-1", "full");
    expect(mocks.setUser).toHaveBeenLastCalledWith(named);

    // A membership reload: id-only until the next answer.
    resetTelemetryIdentity();
    expect(mocks.setUser).toHaveBeenLastCalledWith({ id: "workos-1" });

    setTelemetryIdentity("workos-1", "full");
    setTelemetryIdentity("workos-1", "id_only");
    expect(mocks.setUser).toHaveBeenLastCalledWith({ id: "workos-1" });
  });

  it("ignores a late answer for a previous actor", () => {
    setTelemetryActor("workos-2");
    setSentryActor({ ...member, id: "workos-2" });
    setTelemetryIdentity("workos-1", "full");
    expect(mocks.setUser).toHaveBeenLastCalledWith({ id: "workos-2" });
  });

  it("drops the grant the moment the actor changes", () => {
    setTelemetryIdentity("workos-1", "full");
    setSentryActor(member);
    expect(mocks.setUser).toHaveBeenLastCalledWith(named);

    setTelemetryActor("workos-2");
    // Re-applied for the current Sentry actor, now without a grant.
    expect(mocks.setUser).toHaveBeenLastCalledWith({ id: "workos-1" });
    setSentryActor({ ...member, id: "workos-2" });
    expect(mocks.setUser).toHaveBeenLastCalledWith({ id: "workos-2" });
  });

  it("never names a guest", () => {
    setTelemetryActor("guest-1");
    setTelemetryIdentity("guest-1", "full");
    setSentryActor({ kind: "guest", id: "guest-1" });
    expect(mocks.setUser).toHaveBeenLastCalledWith({ id: "guest-1" });
  });

  it("does nothing when the grant has not changed", () => {
    setSentryActor(member);
    mocks.setUser.mockClear();

    setTelemetryIdentity("workos-1", "id_only");
    resetTelemetryIdentity();
    expect(mocks.setUser).not.toHaveBeenCalled();
  });
});

describe("filterSentryEventIdentity", () => {
  it("strips naming fields unless names are allowed, keeping the id", () => {
    const event = () => ({
      user: {
        id: "workos-1",
        email: "e@example.com",
        username: "e@example.com",
        name: "N",
        ip_address: "203.0.113.9",
        geo: { city: "X" },
      },
    });
    expect(filterSentryEventIdentity(event(), false).user).toEqual({
      id: "workos-1",
    });
    expect(filterSentryEventIdentity(event(), true).user).toEqual(event().user);
  });

  it("leaves events without a user alone", () => {
    expect(filterSentryEventIdentity({}, false)).toEqual({});
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
