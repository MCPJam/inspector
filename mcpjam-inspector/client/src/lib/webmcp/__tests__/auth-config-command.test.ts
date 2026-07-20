import { describe, expect, it } from "vitest";
import { planAuthConfigModal } from "../auth-config-command";

describe("planAuthConfigModal", () => {
  const existing = ["linear", "asana"];

  it("no requested name + a selected server → edit", () => {
    expect(
      planAuthConfigModal({
        selectedServerName: "linear",
        existingServerNames: existing,
      }),
    ).toEqual({ mode: "edit" });
  });

  it("no requested name + no selection → add (blank form)", () => {
    expect(
      planAuthConfigModal({
        selectedServerName: null,
        existingServerNames: existing,
      }),
    ).toEqual({ mode: "add" });
  });

  it("requested name equals the selected server → edit", () => {
    expect(
      planAuthConfigModal({
        requestedServerName: "linear",
        selectedServerName: "linear",
        existingServerNames: existing,
      }),
    ).toEqual({ mode: "edit" });
  });

  it("requested name matches a DIFFERENT existing server → reject, never a silent switch", () => {
    const plan = planAuthConfigModal({
      requestedServerName: "asana",
      selectedServerName: "linear",
      existingServerNames: existing,
    });
    expect("reject" in plan && plan.reject).toMatch(/ui_select_server/);
  });

  it("requested new name → add", () => {
    expect(
      planAuthConfigModal({
        requestedServerName: "new-target",
        selectedServerName: "linear",
        existingServerNames: existing,
      }),
    ).toEqual({ mode: "add" });

    expect(
      planAuthConfigModal({
        requestedServerName: "new-target",
        selectedServerName: null,
        existingServerNames: existing,
      }),
    ).toEqual({ mode: "add" });
  });

  it("exact match only — near-misses are new names, not fuzzy edits", () => {
    expect(
      planAuthConfigModal({
        requestedServerName: "Linear",
        selectedServerName: "linear",
        existingServerNames: existing,
      }),
    ).toEqual({ mode: "add" });
  });
});
