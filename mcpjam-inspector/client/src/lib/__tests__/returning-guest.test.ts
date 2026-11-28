import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GUEST_VISIT_GAP_MS,
  getGuestVisit,
  markGuestDialogClosed,
  resetGuestVisitForTests,
  touchGuestVisit,
} from "../returning-guest";

const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track }));

const DAY = 24 * 60 * 60 * 1000;

describe("returning guest visits", () => {
  beforeEach(() => {
    localStorage.clear();
    resetGuestVisitForTests();
    track.mockClear();
  });

  it("treats the first visit as not returning", () => {
    touchGuestVisit(1_000);
    expect(getGuestVisit()).toMatchObject({
      visitNumber: 1,
      isReturning: false,
    });
    expect(track).not.toHaveBeenCalled();
  });

  it("keeps activity within the gap in the same visit", () => {
    touchGuestVisit(1_000);
    touchGuestVisit(1_000 + GUEST_VISIT_GAP_MS);
    expect(getGuestVisit()).toMatchObject({ visitNumber: 1 });
  });

  it("starts a returning visit after the gap and reports it", () => {
    touchGuestVisit(1_000);
    touchGuestVisit(1_000 + 2 * DAY);
    expect(getGuestVisit()).toMatchObject({
      visitNumber: 2,
      isReturning: true,
      dialogClosed: false,
    });
    expect(track).toHaveBeenCalledWith("returning_guest_detected", {
      visit_number: 2,
      days_since_last_visit: 2,
    });
  });

  it("remembers a closed dialog only for the current visit", () => {
    touchGuestVisit(1_000);
    touchGuestVisit(1_000 + DAY);
    markGuestDialogClosed();
    expect(getGuestVisit()).toMatchObject({
      dialogClosed: true,
    });

    touchGuestVisit(1_000 + DAY + 60_000);
    expect(getGuestVisit()).toMatchObject({ dialogClosed: true });

    touchGuestVisit(1_000 + 2 * DAY);
    expect(getGuestVisit()).toMatchObject({
      visitNumber: 3,
      dialogClosed: false,
    });
  });

  it("starts over when the stored record is corrupt", () => {
    localStorage.setItem("mcpjam:returning-guest-v1", "{not json");
    touchGuestVisit(1_000);
    expect(getGuestVisit()).toMatchObject({ visitNumber: 1 });
  });
});
