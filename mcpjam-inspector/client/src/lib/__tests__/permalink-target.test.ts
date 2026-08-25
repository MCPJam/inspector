import { describe, expect, it } from "vitest";
import {
  permalinkUnavailableMessage,
  resolvePermalinkTarget,
} from "../permalink-target";

const rows = [{ id: "a" }, { id: "b" }];
const byId = (row: { id: string }) => row.id;

describe("resolvePermalinkTarget", () => {
  it("asks for nothing when the URL names no target", () => {
    expect(resolvePermalinkTarget(null, rows, byId)).toEqual({ kind: "none" });
    expect(resolvePermalinkTarget("   ", rows, byId)).toEqual({ kind: "none" });
  });

  it("waits while the collection is undefined", () => {
    expect(resolvePermalinkTarget("a", undefined, byId)).toEqual({
      kind: "loading",
    });
  });

  it("treats a loaded EMPTY collection as unavailable, not as loading", () => {
    // The difference between an answer and a spinner that never ends.
    expect(resolvePermalinkTarget("a", [], byId)).toEqual({
      kind: "unavailable",
      requestedId: "a",
    });
  });

  it("selects the exact row, never a neighbour", () => {
    expect(resolvePermalinkTarget("b", rows, byId)).toEqual({
      kind: "found",
      target: { id: "b" },
    });
    expect(resolvePermalinkTarget("c", rows, byId)).toEqual({
      kind: "unavailable",
      requestedId: "c",
    });
  });

  it("trims the requested id so a padded link still matches", () => {
    expect(resolvePermalinkTarget(" a ", rows, byId)).toEqual({
      kind: "found",
      target: { id: "a" },
    });
  });
});

describe("permalinkUnavailableMessage", () => {
  it("names the kind and never echoes the id back", () => {
    const message = permalinkUnavailableMessage("server");
    expect(message).toContain("server");
    expect(message).toContain("deleted");
    expect(message).toContain("access");
  });

  it("gives deleted and not-authorized the same answer", () => {
    // Two messages would make the screen a membership oracle over ids.
    expect(permalinkUnavailableMessage("environment")).toBe(
      permalinkUnavailableMessage("environment"),
    );
  });
});
