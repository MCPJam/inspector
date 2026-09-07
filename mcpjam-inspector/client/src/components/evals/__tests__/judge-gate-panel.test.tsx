/**
 * Whether the judge may decide a run, and the evidence that says it may.
 *
 * Everything here is rendered FROM SERVER FIELDS. The one number a client must
 * never derive is the agreement rate: `rate` is `null` at zero reviews, and
 * "0%" would report a judge that disagrees with every reviewer rather than one
 * nobody has reviewed. The two refusals are also not interchangeable — a
 * deployment that cannot gate is not a suite that is not calibrated, and only
 * the second one names something a reader can do about it.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useMutation: () => mocks.acknowledge,
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

import {
  describeAgreement,
  gateSwitchDisabledReason,
  JudgeGatePanel,
} from "../judge-gate-panel";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";

type Judge = SuiteCapabilities["judge"];

function judge(overrides: Partial<Judge> = {}): Judge {
  return {
    gating: { enabled: true },
    role: "advisory",
    hasRubric: true,
    agreement: {
      reviews: 20,
      agreements: 18,
      rate: 0.9,
      lowerBound: 0.72,
      threshold: 0.8,
      minReviews: 20,
      eligible: true,
      reasons: [],
    },
    acknowledgement: null,
    ...overrides,
  } as Judge;
}

function renderPanel(
  overrides: {
    judge?: Judge | undefined;
    role?: "advisory" | "gating";
  } = {},
) {
  const onJudgeConfigChange = vi.fn();
  const result = render(
    <JudgeGatePanel
      suiteId="suite-1"
      judge={"judge" in overrides ? overrides.judge : judge()}
      judgeConfig={{ goalCompletion: { role: overrides.role ?? "advisory" } }}
      onJudgeConfigChange={onJudgeConfigChange}
    />,
  );
  return { ...result, onJudgeConfigChange };
}

describe("describeAgreement", () => {
  it("says NO EVIDENCE at zero reviews, never 0%", () => {
    // 0/0 is not "0% agreement". Deriving a rate here is exactly how a judge
    // nobody has reviewed reads as one every reviewer disagrees with.
    expect(
      describeAgreement({
        reviews: 0,
        agreements: 0,
        rate: null,
        lowerBound: null,
        threshold: 0.8,
        minReviews: 20,
        eligible: false,
        reasons: ["insufficient_reviews"],
      }),
    ).toBe("No reviewer labels yet");
    expect(describeAgreement(undefined)).toBe("No reviewer labels yet");
  });

  it("reports the server's counts, rate and lower bound", () => {
    expect(describeAgreement(judge().agreement)).toBe(
      "Agrees with reviewers 18/20 · 90% (at least 72% likely)",
    );
  });
});

describe("gateSwitchDisabledReason", () => {
  it("distinguishes a deployment that cannot gate from a suite that is not calibrated", () => {
    expect(
      gateSwitchDisabledReason(
        judge({
          gating: { enabled: false, reason: "not_enabled_on_deployment" },
        }),
      ),
    ).toBe("Not available on this deployment");

    // The calibration refusal names what would clear it; the deployment one
    // cannot, because no amount of reviewing changes it.
    expect(
      gateSwitchDisabledReason(
        judge({
          agreement: {
            ...judge().agreement,
            reviews: 3,
            agreements: 3,
            rate: 1,
            eligible: false,
            reasons: ["insufficient_reviews"],
          },
        }),
      ),
    ).toBe("Needs 20 blind reviewer labels agreeing at 80% or better");
  });

  it("clears once calibrated, or once an owner has acknowledged", () => {
    expect(gateSwitchDisabledReason(judge())).toBeUndefined();
    expect(
      gateSwitchDisabledReason(
        judge({
          agreement: { ...judge().agreement, eligible: false },
          acknowledgement: {
            acknowledgedBy: "user-1",
            acknowledgedAt: 1,
            judgeTemplateVersion: 3,
            current: true,
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("says it is still checking while capabilities are unread", () => {
    expect(gateSwitchDisabledReason(undefined)).toContain("Checking");
  });
});

describe("JudgeGatePanel", () => {
  it("renders the switch disabled rather than hiding it", () => {
    renderPanel({
      judge: judge({
        gating: { enabled: false, reason: "not_enabled_on_deployment" },
      }),
    });
    // Hiding it would make "this deployment cannot gate" and "this suite is
    // not calibrated" the same empty space.
    const gate = screen.getByRole("switch", {
      name: "Let the judge decide pass or fail",
    });
    expect(gate).toBeDisabled();
    expect(screen.getByTestId("judge-gate-disabled-reason").textContent).toBe(
      "Not available on this deployment",
    );
  });

  it("drafts the role when the switch is usable", async () => {
    const user = userEvent.setup();
    const { onJudgeConfigChange } = renderPanel();
    await user.click(
      screen.getByRole("switch", { name: "Let the judge decide pass or fail" }),
    );
    expect(onJudgeConfigChange).toHaveBeenCalledWith({
      goalCompletion: { role: "gating" },
    });
  });

  it("offers the acknowledgement only when calibration is the blocker", () => {
    const { unmount } = renderPanel();
    // Already eligible: nothing to acknowledge.
    expect(
      screen.queryByRole("button", { name: /Acknowledge and gate anyway/ }),
    ).toBeNull();
    unmount();

    renderPanel({
      judge: judge({
        gating: { enabled: false, reason: "not_enabled_on_deployment" },
        agreement: { ...judge().agreement, eligible: false },
      }),
    });
    // A deployment that cannot gate cannot be acknowledged past either.
    expect(
      screen.queryByRole("button", { name: /Acknowledge and gate anyway/ }),
    ).toBeNull();
  });

  it("requires a reason, and warns that it is stored with a name", async () => {
    const user = userEvent.setup();
    mocks.acknowledge.mockResolvedValue({ acknowledged: true });
    renderPanel({
      judge: judge({ agreement: { ...judge().agreement, eligible: false } }),
    });
    await user.click(
      screen.getByRole("button", { name: /Acknowledge and gate anyway/ }),
    );
    const confirm = screen.getByRole("button", { name: "Acknowledge" });
    expect(confirm).toBeDisabled();
    expect(
      screen.getByText("Stored with your name, not redacted."),
    ).toBeTruthy();

    await user.type(
      screen.getByLabelText("Why gate without calibration"),
      "shipping under deadline",
    );
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(mocks.acknowledge).toHaveBeenCalledWith({
      suiteId: "suite-1",
      reason: "shipping under deadline",
    });
  });

  it("lets a gate that has gone stale be lowered, never raised", async () => {
    // The draft already gates and the deployment (or calibration) no longer
    // allows it. Disabling the switch outright would trap the suite in a state
    // the page itself says is not allowed; only turning it ON needs evidence.
    const user = userEvent.setup();
    const stale = judge({
      gating: { enabled: false, reason: "not_enabled_on_deployment" },
    });
    const { onJudgeConfigChange, unmount } = renderPanel({
      judge: stale,
      role: "gating",
    });
    const gate = screen.getByRole("switch", {
      name: "Let the judge decide pass or fail",
    });
    expect(gate).toBeEnabled();
    // The reason is still said, so the reader knows why it cannot go back up.
    expect(screen.getByTestId("judge-gate-disabled-reason").textContent).toBe(
      "Not available on this deployment",
    );
    await user.click(gate);
    expect(onJudgeConfigChange).toHaveBeenCalledWith({
      goalCompletion: { role: "advisory" },
    });
    unmount();

    // Same judge, advisory draft: raising the gate is still refused.
    renderPanel({ judge: stale, role: "advisory" });
    expect(
      screen.getByRole("switch", { name: "Let the judge decide pass or fail" }),
    ).toBeDisabled();
  });

  it("says when a gate rests on an acknowledgement rather than evidence", () => {
    renderPanel({
      judge: judge({
        agreement: { ...judge().agreement, eligible: false },
        acknowledgement: {
          acknowledgedBy: "user-1",
          acknowledgedAt: 1,
          judgeTemplateVersion: 3,
          current: true,
        },
      }),
      role: "gating",
    });
    expect(
      screen.getByText(/acknowledgement rather than on calibration/),
    ).toBeTruthy();
  });
});

describe("gateSwitchDisabledReason — when the capabilities read failed", () => {
  it("says the read failed instead of claiming to still be checking", () => {
    expect(gateSwitchDisabledReason(undefined)).toMatch(/^Checking/);
    expect(
      gateSwitchDisabledReason(
        undefined,
        "Could not check availability right now",
      ),
    ).toBe("Could not check availability right now");
  });
});

describe("describeAgreement — chance-corrected agreement", () => {
  it("shows kappa beside the rate when the backend reports it, and nothing when it does not", () => {
    expect(describeAgreement({ ...judge().agreement, kappa: 0.7143 })).toBe(
      "Agrees with reviewers 18/20 · 90% (at least 72% likely) · chance-corrected 0.71",
    );
    // `null` is "undefined for this corpus" (both raters constant), not 0.
    expect(describeAgreement({ ...judge().agreement, kappa: null })).toBe(
      "Agrees with reviewers 18/20 · 90% (at least 72% likely)",
    );
    expect(describeAgreement(judge().agreement)).not.toContain(
      "chance-corrected",
    );
  });
});
