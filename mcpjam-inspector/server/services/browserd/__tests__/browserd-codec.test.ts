import { describe, expect, it } from "vitest";
import {
  BrowserdClientError,
  decodeCommandResponse,
  decodeLease,
  decodeLeaseAction,
  decodeStatus,
} from "../browserd-codec";

describe("browserd reply codec", () => {
  it("reads the four lease refusals apart", () => {
    // One outcome to a model ("wait"), four different bugs to a pane. The
    // boundary keeps the distinction rather than flattening it.
    const cases = [
      ["lease_held", "held"],
      ["lease_parked", "parked"],
      ["lease_required", "required"],
      ["lease_held_by_other", "other_holder"],
    ] as const;
    for (const [error, lease] of cases) {
      const decoded = decodeCommandResponse({
        status: 423,
        body: { error, holder: "rail-1", holderKind: "human", bootId: "b" },
      });
      expect(decoded).toMatchObject({ status: "lease_blocked", lease });
    }
  });

  it("defaults an unrecognised 423 to `held` rather than inventing success", () => {
    const decoded = decodeCommandResponse({
      status: 423,
      body: { error: "something_new", bootId: "b" },
    });
    expect(decoded).toMatchObject({ status: "lease_blocked", lease: "held" });
  });

  it("reports what is holding the browser when the daemon says", () => {
    expect(
      decodeLease({
        status: 200,
        body: {
          lease: { state: "held", holder: "s1", holderKind: "script" },
          bootId: "b",
        },
      }),
    ).toMatchObject({ state: "held", holder: "s1", holderKind: "script" });
  });

  it("treats an unlabelled holder as a person", () => {
    // A mislabelled script would make the resume note tell the model a human
    // was here; a person is the safe reading of an absent field.
    expect(
      decodeLease({
        status: 200,
        body: { lease: { state: "parked", holder: "p1" }, bootId: "b" },
      }),
    ).toMatchObject({ holderKind: "human" });
  });

  it("reports a refused acquire as `took: false`, not as an error", () => {
    const { took, lease } = decodeLeaseAction({
      status: 409,
      body: { lease: { state: "held", holder: "other" }, bootId: "b" },
    });
    expect(took).toBe(false);
    expect(lease).toMatchObject({ state: "held", holder: "other" });
  });

  it("throws on statuses that are wiring bugs rather than protocol signals", () => {
    expect(() => decodeStatus({ status: 500, body: {} })).toThrow(
      BrowserdClientError,
    );
    expect(() =>
      decodeCommandResponse({ status: 400, body: { error: "invalid_command" } }),
    ).toThrow(/invalid_command/);
  });

  it("separates the two 409s the daemon can answer with", () => {
    expect(
      decodeCommandResponse({
        status: 409,
        body: { error: "command_unknown_boot", bootId: "b2" },
      }).status,
    ).toBe("unknown_boot");
    expect(
      decodeCommandResponse({
        status: 409,
        body: { error: "stale_observation", result: { ok: false }, bootId: "b" },
      }).status,
    ).toBe("stale_observation");
    expect(
      decodeCommandResponse({ status: 409, body: { bootId: "b" } }).status,
    ).toBe("expired");
  });
});
