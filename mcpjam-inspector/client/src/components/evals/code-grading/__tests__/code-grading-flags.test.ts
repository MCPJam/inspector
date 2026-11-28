import { describe, expect, it } from "vitest";
import { codeGradingGate, readOnlyNote } from "../code-grading-flags";

describe("codeGradingGate", () => {
  it("edits only when the flag is on and capabilities don't refuse", () => {
    expect(codeGradingGate(true, { enabled: true })).toEqual({
      canEdit: true,
      showEmpty: true,
    });
    // A backend without the key: unknown, so the flag decides.
    expect(codeGradingGate(true, undefined).canEdit).toBe(true);
  });

  it("lets a capability refusal win over the flag, with its reason", () => {
    expect(
      codeGradingGate(true, { enabled: false, reason: "flag_unavailable" }),
    ).toEqual({
      canEdit: false,
      reason: "Could not check availability right now",
      showEmpty: true,
    });
  });

  it("needs the flag even when capabilities allow", () => {
    expect(codeGradingGate(false, { enabled: true })).toEqual({
      canEdit: false,
      showEmpty: false,
      reason: "Not enabled for this organization",
    });
  });

  it("gives no reason while the flag is still loading", () => {
    expect(codeGradingGate(undefined, undefined)).toEqual({
      canEdit: false,
      showEmpty: false,
    });
  });
});

describe("readOnlyNote", () => {
  const off = codeGradingGate(false, undefined);

  it("says the stored values still work and can be removed", () => {
    expect(readOnlyNote(off, "scripts")).toBe(
      "Not enabled for this organization. These scripts still run, and you can remove them.",
    );
    expect(readOnlyNote(off, "settings")).toBe(
      "Not enabled for this organization. These settings still apply, and you can remove them.",
    );
    expect(readOnlyNote(off, null)).toBe("Not enabled for this organization.");
  });

  it("says nothing on an editable row", () => {
    expect(
      readOnlyNote(codeGradingGate(true, undefined), "scripts"),
    ).toBeUndefined();
  });
});
