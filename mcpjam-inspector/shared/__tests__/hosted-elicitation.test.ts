import { describe, expect, it } from "vitest";
import {
  HOSTED_ELICITATION_DATA_PART_TYPE,
  isHostedElicitationDataPart,
  isHostedElicitationEvent,
} from "../hosted-elicitation";

const formRequest = {
  kind: "request",
  rendezvousId: "rv-1",
  serverId: "srv-1",
  serverName: "GitHub",
  mode: "form",
  message: "Pick a branch",
  requestedSchema: { type: "object" },
  expiresAt: 1_700_000_000_000,
};

const urlRequest = {
  kind: "request",
  rendezvousId: "rv-2",
  serverId: "srv-1",
  mode: "url",
  message: "Connect your account",
  url: "https://example.com/connect",
  serverElicitationId: "srv-chosen",
  expiresAt: 1_700_000_000_000,
};

describe("isHostedElicitationEvent — request", () => {
  it("accepts form and url requests", () => {
    expect(isHostedElicitationEvent(formRequest)).toBe(true);
    expect(isHostedElicitationEvent(urlRequest)).toBe(true);
  });

  it("rejects a url request with no url", () => {
    // A consent dialog with nothing to consent to is worse than no dialog.
    const { url: _url, ...noUrl } = urlRequest;
    expect(isHostedElicitationEvent(noUrl)).toBe(false);
  });

  it("rejects an unknown or missing mode", () => {
    expect(isHostedElicitationEvent({ ...formRequest, mode: "voice" })).toBe(
      false,
    );
    const { mode: _mode, ...noMode } = formRequest;
    expect(isHostedElicitationEvent(noMode)).toBe(false);
  });

  it.each([
    ["rendezvousId", 1],
    ["serverId", null],
    ["message", { a: 1 }],
    ["expiresAt", "soon"],
  ])("rejects a bad required field: %s", (key, bad) => {
    expect(isHostedElicitationEvent({ ...formRequest, [key]: bad })).toBe(false);
  });

  it("rejects a non-finite expiry", () => {
    // NaN would make the deadline comparison silently never fire.
    expect(isHostedElicitationEvent({ ...formRequest, expiresAt: NaN })).toBe(
      false,
    );
  });

  it.each([["serverName"], ["serverElicitationId"], ["chatSessionId"]])(
    "rejects a present-but-wrong-typed optional: %s",
    (key) => {
      expect(isHostedElicitationEvent({ ...formRequest, [key]: 42 })).toBe(
        false,
      );
    },
  );

  it("accepts omitted optionals", () => {
    expect(
      isHostedElicitationEvent({
        kind: "request",
        rendezvousId: "rv",
        serverId: "s",
        mode: "form",
        message: "m",
        expiresAt: 1,
      }),
    ).toBe(true);
  });
});

describe("isHostedElicitationEvent — resolved", () => {
  it("accepts each terminal outcome", () => {
    for (const outcome of ["answered", "expired", "cancelled"]) {
      expect(
        isHostedElicitationEvent({ kind: "resolved", rendezvousId: "rv", outcome }),
      ).toBe(true);
    }
  });

  it("accepts a valid action and rejects an invented one", () => {
    expect(
      isHostedElicitationEvent({
        kind: "resolved",
        rendezvousId: "rv",
        outcome: "answered",
        action: "decline",
      }),
    ).toBe(true);
    expect(
      isHostedElicitationEvent({
        kind: "resolved",
        rendezvousId: "rv",
        outcome: "answered",
        action: "approve",
      }),
    ).toBe(false);
  });

  it("rejects an unknown outcome", () => {
    expect(
      isHostedElicitationEvent({
        kind: "resolved",
        rendezvousId: "rv",
        outcome: "done",
      }),
    ).toBe(false);
  });
});

describe("isHostedElicitationEvent — url_required", () => {
  const base = {
    kind: "url_required",
    serverId: "srv-1",
    toolCallId: "call-1",
    elicitations: [{ url: "https://example.com/a", elicitationId: "e1" }],
  };

  it("accepts a well-formed notice", () => {
    expect(isHostedElicitationEvent(base)).toBe(true);
  });

  it("rejects an empty elicitations array", () => {
    // Nothing to show — rendering an empty notice is just noise.
    expect(isHostedElicitationEvent({ ...base, elicitations: [] })).toBe(false);
  });

  it("rejects entries missing url or elicitationId", () => {
    expect(
      isHostedElicitationEvent({ ...base, elicitations: [{ url: "https://x" }] }),
    ).toBe(false);
    expect(
      isHostedElicitationEvent({ ...base, elicitations: [{ elicitationId: "e" }] }),
    ).toBe(false);
  });

  it("rejects a wrong-typed optional message on an entry", () => {
    expect(
      isHostedElicitationEvent({
        ...base,
        elicitations: [{ url: "https://x", elicitationId: "e", message: 5 }],
      }),
    ).toBe(false);
  });
});

describe("isHostedElicitationEvent — shape", () => {
  it.each([[null], [undefined], ["str"], [42], [[]], [{}], [{ kind: "nope" }]])(
    "rejects %p",
    (value) => {
      expect(isHostedElicitationEvent(value)).toBe(false);
    },
  );
});

describe("isHostedElicitationDataPart", () => {
  it("accepts the wire literal wrapping a valid event", () => {
    expect(
      isHostedElicitationDataPart({
        type: HOSTED_ELICITATION_DATA_PART_TYPE,
        data: formRequest,
      }),
    ).toBe(true);
  });

  it("rejects another part type", () => {
    expect(
      isHostedElicitationDataPart({ type: "data-rpc-log", data: formRequest }),
    ).toBe(false);
  });

  it("rejects a valid wrapper around an invalid event", () => {
    expect(
      isHostedElicitationDataPart({
        type: HOSTED_ELICITATION_DATA_PART_TYPE,
        data: { kind: "request" },
      }),
    ).toBe(false);
  });
});

describe("isHostedElicitationEvent — insufficient_scope (SEP-2350)", () => {
  it("accepts a challenge carrying requiredScope", () => {
    expect(
      isHostedElicitationEvent({
        kind: "insufficient_scope",
        serverId: "srv-1",
        serverName: "GitHub",
        toolCallId: "call-1",
        requiredScope: "read write",
        resourceMetadataUrl: "https://rs.example/.well-known",
      }),
    ).toBe(true);
  });

  it("accepts a challenge carrying only resourceMetadataUrl", () => {
    expect(
      isHostedElicitationEvent({
        kind: "insufficient_scope",
        serverId: "srv-1",
        resourceMetadataUrl: "https://rs.example/.well-known",
      }),
    ).toBe(true);
  });

  it("rejects a challenge with no actionable fields", () => {
    expect(
      isHostedElicitationEvent({
        kind: "insufficient_scope",
        serverId: "srv-1",
        toolCallId: "call-1",
      }),
    ).toBe(false);
  });

  it("rejects a challenge with a non-string requiredScope", () => {
    expect(
      isHostedElicitationEvent({
        kind: "insufficient_scope",
        serverId: "srv-1",
        requiredScope: 42,
      }),
    ).toBe(false);
  });

  it("rejects a challenge missing serverId", () => {
    expect(
      isHostedElicitationEvent({
        kind: "insufficient_scope",
        requiredScope: "read",
      }),
    ).toBe(false);
  });
});
