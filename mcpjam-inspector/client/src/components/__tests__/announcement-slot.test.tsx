import { DialogDescription, DialogTitle } from "@mcpjam/design-system/dialog";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { Toaster } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncementQueueProvider } from "../announcement-slot";
import { TrialDecisionDialog } from "../billing/TrialDecisionDialog";
import { DARK_DEFAULT_NUDGE_KEY, DarkDefaultNudge } from "../DarkDefaultNudge";
import {
  CONFORMANCE_SPOTLIGHT_DELAY_MS,
  CONFORMANCE_SPOTLIGHT_STORAGE_KEY,
  ConformanceSpotlight,
} from "../sidebar/conformance-spotlight";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const DARK_NUDGE = "Dark mode is now the default.";
const SPOTLIGHT = "Check your server against the MCP spec";
const TRIAL = "Choose how to continue";

function Announcements({
  enabled = true,
  dark = true,
  trial = false,
}: {
  enabled?: boolean;
  dark?: boolean;
  trial?: boolean;
}) {
  const [trialDismissed, setTrialDismissed] = useState(false);
  return (
    <AnnouncementQueueProvider enabled={enabled}>
      <Toaster />
      <DarkDefaultNudge enabled={enabled && dark} />
      <ConformanceSpotlight
        enabled={enabled}
        onConformancePage={false}
        onNavigate={vi.fn()}
      >
        <button type="button">Conformance</button>
      </ConformanceSpotlight>
      <TrialDecisionDialog
        eligible={trial && !trialDismissed}
        onDismiss={() => setTrialDismissed(true)}
      >
        <DialogTitle>{TRIAL}</DialogTitle>
        <DialogDescription>Your trial has ended.</DialogDescription>
      </TrialDecisionDialog>
    </AnnouncementQueueProvider>
  );
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  localStorage.clear();
});

afterEach(() => {
  // Unmounting a shown toast makes sonner schedule its dismissal on a
  // requestAnimationFrame, in module-level state that outlives the test. Left
  // to the global cleanup, which runs on real timers, that frame fires at an
  // arbitrary point in the next test and can dismiss the dark nudge it has just
  // shown under the same id. Unmount and flush it here, on the fake clock.
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("proactive announcements", () => {
  it.each(["dismissal", "timeout"])(
    "shows the spotlight only after the dark nudge finishes its %s",
    async (close) => {
      render(<Announcements />);
      await advance(50);
      await advance(CONFORMANCE_SPOTLIGHT_DELAY_MS);

      expect(screen.getByText(DARK_NUDGE)).toBeVisible();
      expect(screen.queryByText(SPOTLIGHT)).not.toBeInTheDocument();
      expect(
        localStorage.getItem(CONFORMANCE_SPOTLIGHT_STORAGE_KEY),
      ).toBeNull();

      if (close === "dismissal") {
        fireEvent.click(screen.getByRole("button", { name: "Keep dark" }));
        await advance(50);
      } else {
        await advance(20_000 - CONFORMANCE_SPOTLIGHT_DELAY_MS);
      }
      expect(screen.getByText(DARK_NUDGE)).toBeInTheDocument();
      expect(screen.queryByText(SPOTLIGHT)).not.toBeInTheDocument();

      await advance(250);
      expect(screen.queryByText(DARK_NUDGE)).not.toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: SPOTLIGHT })).toBeVisible();
    },
  );

  it("does not interrupt the spotlight or mark the waiting dark nudge seen", async () => {
    const { rerender } = render(<Announcements dark={false} />);
    await advance(CONFORMANCE_SPOTLIGHT_DELAY_MS);
    expect(screen.getByRole("dialog", { name: SPOTLIGHT })).toBeVisible();

    rerender(<Announcements trial />);
    await advance(50);
    expect(screen.queryByText(DARK_NUDGE)).not.toBeInTheDocument();
    expect(screen.queryByText(TRIAL)).not.toBeInTheDocument();
    expect(localStorage.getItem(DARK_DEFAULT_NUDGE_KEY)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.getByRole("dialog", { name: TRIAL })).toBeVisible();
    expect(localStorage.getItem(DARK_DEFAULT_NUDGE_KEY)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await advance(50);
    expect(screen.queryByText(TRIAL)).not.toBeInTheDocument();
    expect(screen.getByText(DARK_NUDGE)).toBeVisible();
    expect(localStorage.getItem(DARK_DEFAULT_NUDGE_KEY)).toBe("1");
  });

  it("suppresses every surface while disabled, then lets the trial dialog take the first turn", async () => {
    const { rerender } = render(<Announcements enabled={false} trial />);
    await advance(CONFORMANCE_SPOTLIGHT_DELAY_MS);
    expect(screen.queryByText(DARK_NUDGE)).not.toBeInTheDocument();
    expect(screen.queryByText(SPOTLIGHT)).not.toBeInTheDocument();
    expect(screen.queryByText(TRIAL)).not.toBeInTheDocument();
    expect(localStorage.getItem(DARK_DEFAULT_NUDGE_KEY)).toBeNull();
    expect(localStorage.getItem(CONFORMANCE_SPOTLIGHT_STORAGE_KEY)).toBeNull();

    rerender(<Announcements trial />);
    await advance(CONFORMANCE_SPOTLIGHT_DELAY_MS);
    expect(screen.getByRole("dialog", { name: TRIAL })).toBeVisible();
    expect(screen.queryByText(DARK_NUDGE)).not.toBeInTheDocument();
    expect(screen.queryByText(SPOTLIGHT)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await advance(50);
    expect(screen.queryByText(TRIAL)).not.toBeInTheDocument();
    expect(screen.getByText(DARK_NUDGE)).toBeVisible();
    expect(screen.queryByText(SPOTLIGHT)).not.toBeInTheDocument();
  });
});
