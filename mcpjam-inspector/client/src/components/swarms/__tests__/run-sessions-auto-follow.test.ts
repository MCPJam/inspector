/**
 * Auto-follow policy: while a run is live and the viewer hasn't pinned a
 * session, the live pane follows a RUNNING attempt. The decision is pure so the
 * rules are pinned down here rather than inferred from a provider render.
 */
import { describe, expect, it } from "vitest";
import {
  isDeepLinkPending,
  pickAutoFollowCell,
} from "../run-sessions-context";

describe("pickAutoFollowCell", () => {
  it("picks the first running attempt when nothing is selected", () => {
    expect(
      pickAutoFollowCell({
        cellStatus: { "host_a:0": "succeeded", "host_a:1": "running" },
        currentCell: null,
      }),
    ).toEqual({ targetKey: "host_a", sessionIndex: 1 });
  });

  it("stays on the watched attempt while it is still running", () => {
    // Don't yank the view off a live session just because another one started.
    expect(
      pickAutoFollowCell({
        cellStatus: { "host_a:0": "running", "host_b:0": "running" },
        currentCell: "host_a:0",
      }),
    ).toBeNull();
  });

  it("hands off to the next running attempt when the watched one finishes", () => {
    // The half that was missing: previously the view selected once and then sat
    // on a completed session while the rest of the run played out unwatched.
    expect(
      pickAutoFollowCell({
        cellStatus: { "host_a:0": "succeeded", "host_b:0": "running" },
        currentCell: "host_a:0",
      }),
    ).toEqual({ targetKey: "host_b", sessionIndex: 0 });
  });

  it("stays put when nothing is running", () => {
    // Never jump to a finished attempt — the viewer keeps what they were reading.
    expect(
      pickAutoFollowCell({
        cellStatus: { "host_a:0": "succeeded", "host_b:0": "failed" },
        currentCell: "host_a:0",
      }),
    ).toBeNull();
    expect(
      pickAutoFollowCell({
        cellStatus: { "host_a:0": "pending" },
        currentCell: null,
      }),
    ).toBeNull();
  });

  it("splits a targetKey that itself contains a colon", () => {
    // `environment:e1` is a real target key shape — returning the parsed pieces
    // keeps the caller from re-deriving them and getting this wrong.
    expect(
      pickAutoFollowCell({
        cellStatus: { "environment:e1:2": "running" },
        currentCell: null,
      }),
    ).toEqual({ targetKey: "environment:e1", sessionIndex: 2 });
  });

  it("rejects a malformed cell key rather than guessing", () => {
    expect(
      pickAutoFollowCell({
        cellStatus: { "no-colon": "running" },
        currentCell: null,
      }),
    ).toBeNull();
    expect(
      pickAutoFollowCell({
        cellStatus: { "host_a:notanumber": "running" },
        currentCell: null,
      }),
    ).toBeNull();
  });

  it("does not re-select the cell it is already on", () => {
    expect(
      pickAutoFollowCell({
        cellStatus: { "host_a:0": "running" },
        currentCell: "host_a:0",
      }),
    ).toBeNull();
  });
});

describe("isDeepLinkPending", () => {
  it("is false with no deep link at all", () => {
    expect(
      isDeepLinkPending({
        hasDeepLink: false,
        applied: false,
        sessionsStatus: "LoadingFirstPage",
      }),
    ).toBe(false);
  });

  it("holds auto-follow off only while a page fetch is in flight", () => {
    for (const sessionsStatus of ["LoadingFirstPage", "LoadingMore"]) {
      expect(
        isDeepLinkPending({ hasDeepLink: true, applied: false, sessionsStatus }),
      ).toBe(true);
    }
  });

  it("releases on any settled status, so the hold always ends", () => {
    // Two ways this used to hang forever: a URL naming a thread this run never
    // had (suppressing auto-follow for the provider's whole life), and a target
    // past the first page — `CanLoadMore` is a steady state, since pagination
    // advances only when something asks it to. Both leave the viewer on nothing
    // while the run plays out, so neither may gate auto-follow. Chasing the
    // target across pages is the provider's auto-pagination effect's job, and a
    // link that lands later still wins by pinning the selection.
    for (const sessionsStatus of ["CanLoadMore", "Exhausted"]) {
      expect(
        isDeepLinkPending({ hasDeepLink: true, applied: false, sessionsStatus }),
      ).toBe(false);
    }
  });

  it("releases as soon as the deep link has been applied", () => {
    // Applying one pins the selection, so auto-follow stands down anyway — but
    // the two gates must agree, or the "Following" badge lies.
    expect(
      isDeepLinkPending({
        hasDeepLink: true,
        applied: true,
        sessionsStatus: "LoadingMore",
      }),
    ).toBe(false);
  });
});
