import { describe, expect, it } from "vitest";
import {
  GLOBAL_GATE_CATALOG,
  globalGateDescription,
  globalGateDetail,
  globalGateLabel,
  isGlobalPolicyKind,
} from "../predicate-kinds";

describe("global gate catalog", () => {
  it("defines labels, descriptions, and details for every policy menu kind", () => {
    for (const entry of GLOBAL_GATE_CATALOG) {
      expect(isGlobalPolicyKind(entry.kind)).toBe(true);
      expect(globalGateLabel(entry.kind)).toBe(entry.label);
      expect(globalGateDescription(entry.kind)).toBe(entry.description);
      expect(globalGateDetail(entry.kind)).toBe(entry.detail);
    }
  });
});
