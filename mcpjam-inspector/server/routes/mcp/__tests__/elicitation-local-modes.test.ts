import { describe, expect, it } from "vitest";
import {
  initElicitationCallback,
  narrowElicitationToLocalSupport,
} from "../elicitation.js";

/**
 * The local SSE bridge is form-only. These lock "advertise = enforce" on that
 * path: whatever goes on the wire must be something the bridge can complete.
 */
describe("narrowElicitationToLocalSupport", () => {
  it("strips url while keeping form", () => {
    // The host toggle can write {form,url}. Local must not claim url: the SDK
    // would accept the request and the bridge would drop the URL, leaving a
    // form the user cannot complete.
    expect(
      narrowElicitationToLocalSupport({
        roots: {},
        elicitation: { form: {}, url: {} },
      }),
    ).toEqual({ roots: {}, elicitation: { form: {} } });
  });

  it("drops the capability entirely when only url was declared", () => {
    // Narrowing {url:{}} to {} would silently mean "form" — a capability the
    // caller never asked for. Claiming nothing is the honest outcome.
    expect(
      narrowElicitationToLocalSupport({ roots: {}, elicitation: { url: {} } }),
    ).toEqual({ roots: {} });
  });

  it("leaves bare {} untouched", () => {
    // Already form-only per the spec's back-compat rule; rewriting it would
    // churn configs for no behavior change.
    const caps = { elicitation: {} };
    expect(narrowElicitationToLocalSupport(caps)).toBe(caps);
  });

  it("leaves form-only declarations untouched in value", () => {
    expect(narrowElicitationToLocalSupport({ elicitation: { form: {} } })).toEqual(
      { elicitation: { form: {} } },
    );
  });

  it("preserves unrelated capabilities and unknown elicitation sub-keys are dropped", () => {
    // Unknown modes are, by definition, modes this bridge cannot complete.
    expect(
      narrowElicitationToLocalSupport({
        sampling: {},
        elicitation: { form: {}, telepathy: {} },
      }),
    ).toEqual({ sampling: {}, elicitation: { form: {} } });
  });

  it.each([
    [undefined],
    [{}],
    [{ roots: {} }],
    [{ elicitation: true }],
    [{ elicitation: "yes" }],
    [{ elicitation: [] }],
  ])("passes through non-object / absent elicitation: %p", (caps) => {
    expect(narrowElicitationToLocalSupport(caps as any)).toBe(caps);
  });

  it("does not mutate the input", () => {
    const caps = { elicitation: { form: {}, url: {} } };
    narrowElicitationToLocalSupport(caps);
    expect(caps).toEqual({ elicitation: { form: {}, url: {} } });
  });

  describe("urlCapable — the MRTR bridge fulfils this connection", () => {
    it("keeps a declared url", () => {
      // The MRTR bridge completes url rounds through UrlElicitationConsent, so
      // pruning url here is what made every modern url-mode tool fail with
      // -32021 before the server could ever ask.
      expect(
        narrowElicitationToLocalSupport(
          { roots: {}, elicitation: { form: {}, url: {} } },
          { urlCapable: true },
        ),
      ).toEqual({ roots: {}, elicitation: { form: {}, url: {} } });
    });

    it("keeps a url-only declaration instead of dropping the capability", () => {
      expect(
        narrowElicitationToLocalSupport(
          { elicitation: { url: {} } },
          { urlCapable: true },
        ),
      ).toEqual({ elicitation: { url: {} } });
    });

    it("never INVENTS url — a form-only declaration stays form-only", () => {
      // The flag widens what may SURVIVE narrowing; it is not an advertisement
      // in its own right. A host profile that declares form-only (emulating a
      // host that has no url support) must go on the wire unchanged.
      expect(
        narrowElicitationToLocalSupport(
          { elicitation: { form: {} } },
          { urlCapable: true },
        ),
      ).toEqual({ elicitation: { form: {} } });
    });

    it("still prunes unknown modes", () => {
      expect(
        narrowElicitationToLocalSupport(
          { elicitation: { form: {}, url: {}, telepathy: {} } },
          { urlCapable: true },
        ),
      ).toEqual({ elicitation: { form: {}, url: {} } });
    });

    it("leaves bare {} untouched (form-only by the back-compat rule)", () => {
      const caps = { elicitation: {} };
      expect(narrowElicitationToLocalSupport(caps, { urlCapable: true })).toBe(
        caps,
      );
    });
  });
});

/**
 * The connect-time narrowing keeps `url` for any connection that CAN land
 * modern, which includes the unpinned auto-negotiating one. When such a
 * connection lands legacy instead, this bridge is the fulfiller — and the SDK
 * will pass a url request through, because we advertised url. Refuse it rather
 * than render a form the user cannot complete.
 */
describe("initElicitationCallback — url mode on the legacy bridge", () => {
  function captureCallback() {
    let callback: any;
    const manager = {
      setElicitationCallback: (cb: any) => {
        callback = cb;
      },
      getPendingElicitations: () => new Map(),
    } as any;
    initElicitationCallback(manager);
    return callback;
  }

  it("rejects a url-mode request instead of broadcasting a form", async () => {
    const callback = captureCallback();
    await expect(
      callback({
        requestId: "r1",
        serverId: "srv",
        message: "Open the dashboard",
        mode: "url",
        url: "https://example.com/dash",
      }),
    ).rejects.toThrow(/URL-mode elicitation is not supported/);
  });

  it("does not fabricate a user decision", async () => {
    // Resolving {action:"decline"} would tell the server the user declined.
    // No user was ever asked.
    const callback = captureCallback();
    const result = await callback({
      requestId: "r2",
      message: "m",
      mode: "url",
      url: "https://example.com",
    }).catch((err: Error) => err);
    expect(result).toBeInstanceOf(Error);
  });

  it("leaves form mode on the normal path", async () => {
    const callback = captureCallback();
    // Form requests return a pending promise (resolved later by the SSE
    // response route), so assert it stays unsettled rather than rejecting.
    const settled = await Promise.race([
      callback({ requestId: "r3", message: "m", schema: {} }).then(
        () => "settled",
        () => "rejected",
      ),
      Promise.resolve("pending"),
    ]);
    expect(settled).toBe("pending");
  });

  it("treats an absent mode as form (pre-2025-11-25 back-compat)", async () => {
    const callback = captureCallback();
    const settled = await Promise.race([
      callback({ requestId: "r4", message: "m" }).then(
        () => "settled",
        () => "rejected",
      ),
      Promise.resolve("pending"),
    ]);
    expect(settled).toBe("pending");
  });
});
