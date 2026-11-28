import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGuestVisit,
  markGuestDialogClosed,
  resetGuestVisitForTests,
  touchGuestVisit,
} from "../returning-guest";

const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track }));

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 0, day, hour, minute).getTime();

describe("returning guest visits", () => {
  beforeEach(() => {
    localStorage.clear();
    resetGuestVisitForTests();
    track.mockClear();
  });

  it("treats the first visit as not returning", () => {
    touchGuestVisit(at(15, 9));
    expect(getGuestVisit()).toMatchObject({
      visitNumber: 1,
      isReturning: false,
    });
    expect(track).not.toHaveBeenCalled();
  });

  it("keeps the rest of the calendar day in the same visit", () => {
    touchGuestVisit(at(15, 0, 5));
    touchGuestVisit(at(15, 23, 59));
    expect(getGuestVisit()).toMatchObject({ visitNumber: 1 });
  });

  it("starts a returning visit on the next calendar day", () => {
    touchGuestVisit(at(15, 23, 50));
    touchGuestVisit(at(16, 0, 10));
    expect(getGuestVisit()).toMatchObject({
      visitNumber: 2,
      isReturning: true,
    });
    expect(track).toHaveBeenCalledWith("returning_guest_detected", {
      visit_number: 2,
      days_since_last_visit: 1,
    });
  });

  it("reports how many days the guest was away", () => {
    touchGuestVisit(at(15, 9));
    touchGuestVisit(at(17, 8));
    expect(track).toHaveBeenCalledWith("returning_guest_detected", {
      visit_number: 2,
      days_since_last_visit: 2,
    });
  });

  it("remembers a closed dialog only for the current day", () => {
    touchGuestVisit(at(15, 9));
    touchGuestVisit(at(16, 9));
    markGuestDialogClosed();
    expect(getGuestVisit()).toMatchObject({ dialogClosed: true });

    touchGuestVisit(at(16, 18));
    expect(getGuestVisit()).toMatchObject({ dialogClosed: true });

    touchGuestVisit(at(17, 9));
    expect(getGuestVisit()).toMatchObject({
      visitNumber: 3,
      dialogClosed: false,
    });
  });

  it("starts over when the stored record is corrupt", () => {
    localStorage.setItem("mcpjam:returning-guest-v1", "{not json");
    touchGuestVisit(at(15, 9));
    expect(getGuestVisit()).toMatchObject({ visitNumber: 1 });
  });
});
