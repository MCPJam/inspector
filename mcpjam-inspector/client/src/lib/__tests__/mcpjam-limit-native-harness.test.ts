import { beforeEach, describe, expect, it } from "vitest";
import { notifyMCPJamLimitError, notifyMCPJamLimitErrorFromResponse } from "../mcpjam-limit";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { useNativeHarnessLimitDialogStore } from "@/stores/native-harness-limit-dialog-store";

const SENTENCE =
  "This organization has used its 20 free native harness turns. Upgrade your plan to keep using them, or switch to MCPJam Harness.";

const notice = () => useNativeHarnessLimitDialogStore.getState().notice;

beforeEach(() => {
  useNativeHarnessLimitDialogStore.setState({
    notice: null,
    notifiedKeys: new Set(),
  });
  useMCPJamLimitDialogStore.setState({
    notifiedKeys: new Set<string>(),
    authStatus: "signedIn",
    isOpen: false,
    intent: null,
    outOfCreditsHit: false,
    outOfCreditsOrganizationId: null,
  });
});

describe("notifyMCPJamLimitError for the native harness trial", () => {
  it("opens the native harness dialog for the Playground's stream error", () => {
    // `runHarnessTurn` sends the turn's failure as this JSON text.
    const handled = notifyMCPJamLimitError({
      message: JSON.stringify({
        message: SENTENCE,
        code: "native_harness_trial_exhausted",
      }),
    });

    expect(handled).toBe(true);
    expect(notice()).toEqual({});
    // Buying credits does not lift it: no credit dialog, and no empty wallet.
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(useMCPJamLimitDialogStore.getState().outOfCreditsHit).toBe(false);
  });

  it("reads the code from a refused computer's response body", async () => {
    const response = new Response(
      JSON.stringify({
        code: "CONFLICT",
        message: `This turn needs a disposable computer, and one couldn't be started: ${SENTENCE}`,
        details: {
          reason: "PLAYGROUND_SANDBOX_PROVISION_FAILED",
          code: "native_harness_trial_exhausted",
        },
      }),
      { status: 409 },
    );

    expect(await notifyMCPJamLimitErrorFromResponse(response)).toBe(true);
    expect(notice()).toEqual({});
  });

  it("reads a stored attempt's code beside a sentence that lost it", () => {
    notifyMCPJamLimitError({
      runId: "run_1",
      swarmRunGroupId: "wave_1",
      organizationId: "org_1",
      code: "native_harness_trial_exhausted",
      message: SENTENCE,
      surface: "swarm",
    });

    expect(notice()).toEqual({ organizationId: "org_1" });
  });

  it("reads the runner's wire form", () => {
    notifyMCPJamLimitError({
      message: `${SENTENCE} (native_harness_trial_exhausted, HTTP 403)`,
    });

    expect(notice()).not.toBeNull();
  });

  it("opens once per run, so a dismissed dialog stays dismissed", () => {
    const report = () =>
      notifyMCPJamLimitError({
        runId: "run_1",
        organizationId: "org_1",
        code: "native_harness_trial_exhausted",
        message: SENTENCE,
      });
    report();
    useNativeHarnessLimitDialogStore.getState().close();

    expect(report()).toBe(true);
    expect(notice()).toBeNull();
  });

  it("sends a User Testing link to the owner notice", () => {
    notifyMCPJamLimitError({
      message: JSON.stringify({
        message: "This study isn't set up correctly yet. Let the study owner know.",
        code: "native_harness_trial_exhausted",
      }),
      surface: "scenario",
    });

    expect(notice()).toEqual({ surface: "scenario" });
  });

  it("leaves every other refusal alone", () => {
    expect(
      notifyMCPJamLimitError({ message: "native harness turns are fun" }),
    ).toBe(false);
    expect(notice()).toBeNull();
  });

  // Box reservation refuses a project with no organization with a plain 400
  // and no trial code: an upgrade would not fix it, so it stays an error.
  it("leaves a project with no organization to the ordinary error", async () => {
    const NO_ORGANIZATION =
      "This project has no organization, so it can't run a native harness. Use MCPJam Harness for its clients.";
    expect(
      notifyMCPJamLimitError({
        message: JSON.stringify({
          message: NO_ORGANIZATION,
          code: "harness_box_reservation_failed",
        }),
      }),
    ).toBe(false);
    const response = new Response(
      JSON.stringify({
        code: "CONFLICT",
        message: `This turn needs a disposable computer, and one couldn't be started: ${NO_ORGANIZATION}`,
        details: { reason: "PLAYGROUND_SANDBOX_PROVISION_FAILED" },
      }),
      { status: 409 },
    );
    expect(await notifyMCPJamLimitErrorFromResponse(response)).toBe(false);

    expect(notice()).toBeNull();
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });
});
