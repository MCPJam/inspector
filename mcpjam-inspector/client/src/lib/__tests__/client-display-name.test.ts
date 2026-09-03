import { describe, expect, it } from "vitest";
import { resolveClientDisplayNames } from "../client-display-name";

const client = (hostId: string, name: string, createdAt: number) => ({
  hostId,
  name,
  createdAt,
});

describe("resolveClientDisplayNames", () => {
  it("reserves the unsuffixed name for a preset", () => {
    const names = resolveClientDisplayNames(
      [client("second", "Cursor", 2), client("first", "Cursor", 1)],
      ["Cursor"],
    );
    expect(Object.fromEntries(names)).toEqual({
      first: "Cursor #2",
      second: "Cursor #3",
    });
  });

  it("keeps the first custom name unsuffixed when no preset owns it", () => {
    const names = resolveClientDisplayNames(
      [client("first", "Foo", 1), client("second", "foo", 2)],
      [],
    );
    expect(Object.fromEntries(names)).toEqual({
      first: "Foo",
      second: "Foo #2",
    });
  });

  it("uses host id as the deterministic tie breaker", () => {
    const names = resolveClientDisplayNames(
      [client("b", "Cursor", 1), client("a", "Cursor", 1)],
      ["Cursor"],
    );
    expect(names.get("a")).toBe("Cursor #2");
    expect(names.get("b")).toBe("Cursor #3");
  });

  it("does not collide with an intentional stored suffix", () => {
    const names = resolveClientDisplayNames(
      [client("copy", "Cursor", 1), client("intentional", "Cursor #2", 2)],
      ["Cursor"],
    );
    expect(names.get("copy")).toBe("Cursor #3");
    expect(names.get("intentional")).toBe("Cursor #2");
  });

  it("compacts numbering when an earlier copy is removed", () => {
    const names = resolveClientDisplayNames(
      [client("later", "Cursor", 2)],
      ["Cursor"],
    );
    expect(names.get("later")).toBe("Cursor #2");
  });
});
