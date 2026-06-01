import { describe, it, expect } from "vitest";
import { argMatch } from "../src/predicates/argMatcher";
import type { ArgMatcher } from "../src/predicates/types";

describe("argMatch", () => {
  type Row = {
    name: string;
    matcher: ArgMatcher;
    actual: Record<string, unknown>;
    expected: boolean;
  };

  const rows: Row[] = [
    // partial (default)
    {
      name: "partial: expected subset present",
      matcher: { args: { airline: "DL" } },
      actual: { airline: "DL", seat: "12A" },
      expected: true,
    },
    {
      name: "partial: value mismatch fails",
      matcher: { args: { airline: "DL" } },
      actual: { airline: "UA" },
      expected: false,
    },
    {
      name: "partial: empty expected matches anything",
      matcher: { args: {} },
      actual: { airline: "UA" },
      expected: true,
    },
    {
      name: "partial: placeholder type check passes",
      matcher: { args: { airline: "string" } },
      actual: { airline: "anything" },
      expected: true,
    },
    {
      name: "partial: placeholder type check fails on wrong type",
      matcher: { args: { count: "number" } },
      actual: { count: "five" },
      expected: false,
    },
    // exact
    {
      name: "exact: deep equality passes",
      matcher: { args: { airline: "DL", seat: "1A" }, argumentMatching: "exact" },
      actual: { airline: "DL", seat: "1A" },
      expected: true,
    },
    {
      name: "exact: extra keys fail",
      matcher: { args: { airline: "DL" }, argumentMatching: "exact" },
      actual: { airline: "DL", seat: "1A" },
      expected: false,
    },
    {
      name: "exact: empty expected does not match non-empty actual",
      matcher: { args: {}, argumentMatching: "exact" },
      actual: { airline: "DL" },
      expected: false,
    },
    // ignore
    {
      name: "ignore: any args pass",
      matcher: { args: { airline: "DL" }, argumentMatching: "ignore" },
      actual: { totally: "different" },
      expected: true,
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      expect(argMatch(row.matcher, row.actual)).toBe(row.expected);
    });
  }
});
