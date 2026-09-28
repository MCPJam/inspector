import { describe, expect, it } from "vitest";
import {
  PR_SERVER_LABEL,
  displayRunServerNames,
  isEphemeralCheckServerName,
} from "../github-check-server-name";

describe("github check server names", () => {
  it("recognises only the worker's ephemeral name", () => {
    expect(
      isEphemeralCheckServerName("gh-check-p57h0dafyahm32m3s38vp83kbn8e5v9m"),
    ).toBe(true);
    // A real server a user named after the feature is not one of ours.
    expect(isEphemeralCheckServerName("gh-check")).toBe(false);
    expect(isEphemeralCheckServerName("gh-checks staging")).toBe(false);
    expect(isEphemeralCheckServerName("bart")).toBe(false);
  });

  it("shows the suite's servers in place of the check's throwaway one", () => {
    expect(
      displayRunServerNames(["gh-check-trigger1"], ["bart", "lisa"]),
    ).toEqual(["bart", "lisa"]);
  });

  it("collapses to one label when the suite names no servers", () => {
    expect(displayRunServerNames(["gh-check-trigger1"], [])).toEqual([
      PR_SERVER_LABEL,
    ]);
  });

  it("leaves an ordinary run untouched and never repeats a name", () => {
    expect(displayRunServerNames(["bart", "bart"])).toEqual(["bart"]);
    expect(
      displayRunServerNames(["bart", "gh-check-trigger1"], ["bart"]),
    ).toEqual(["bart"]);
  });
});
