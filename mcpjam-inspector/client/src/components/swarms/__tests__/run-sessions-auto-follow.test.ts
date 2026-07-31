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

  it("holds auto-follow off while the target could still load", () => {
    for (const sessionsStatus of [
      "LoadingFirstPage",
      "LoadingMore",
      "CanLoadMore",
    ]) {
      expect(
        isDeepLinkPending({ hasDeepLink: true, applied: false, sessionsStatus }),
      ).toBe(true);
    }
  });

  it("releases once pagination is exhausted and the link never matched", () => {
    // The bug this pins down: a URL naming a thread this run never had used to
    // suppress auto-follow for the provider's whole life, so the viewer sat on
    // nothing while the run played out.
    expect(
      isDeepLinkPending({
        hasDeepLink: true,
        applied: false,
        sessionsStatus: "Exhausted",
      }),
    ).toBe(false);
  });

  it("releases as soon as the deep link has been applied", () => {
    // Applying one pins the selection, so auto-follow stands down anyway — but
    // the two gates must agree, or the "Following" badge lies.
    expect(
      isDeepLinkPending({
        hasDeepLink: true,
        applied: true,
        sessionsStatus: "CanLoadMore",
      }),
    ).toBe(false);
  });
});
