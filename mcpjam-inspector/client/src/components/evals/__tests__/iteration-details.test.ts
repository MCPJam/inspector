import { describe, expect, it } from "vitest";
import { resolveFormattedArgumentValue } from "../iteration-details";

describe("resolveFormattedArgumentValue", () => {
  it("renders object arguments as structured content", () => {
    expect(
      resolveFormattedArgumentValue({
        workspace: "demo",
        includeCompleted: false,
      }),
    ).toEqual({
      kind: "structured",
      value: {
        workspace: "demo",
        includeCompleted: false,
      },
    });
  });

  it("parses stringified JSON arrays into structured content", () => {
    expect(
      resolveFormattedArgumentValue(
        '[{"type":"rectangle","id":"r1"},{"type":"rectangle","id":"r2"}]',
      ),
    ).toEqual({
      kind: "structured",
      value: [
        { type: "rectangle", id: "r1" },
        { type: "rectangle", id: "r2" },
      ],
    });
  });

  it("keeps short plain strings inline", () => {
    expect(resolveFormattedArgumentValue("read_me")).toEqual({
      kind: "text",
      value: "read_me",
      renderAsBlock: false,
    });
  });

  it("uses a block renderer for long plain strings", () => {
    expect(resolveFormattedArgumentValue("x".repeat(160))).toEqual({
      kind: "text",
      value: "x".repeat(160),
      renderAsBlock: true,
    });
  });
});
