import { describe, expect, it } from "vitest";
import {
  EVAL_IA_SURFACE_SEQUENCE,
  getEvalIaSurfaceReference,
} from "../eval-ia-surfaces";

describe("eval IA surface sequence", () => {
  it("keeps the canonical surfaces in dependency order", () => {
    expect(EVAL_IA_SURFACE_SEQUENCE.map((surface) => surface.id)).toEqual([
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
      "S6",
    ]);
    expect(getEvalIaSurfaceReference("S1").primary).toBe("S1_Primary");
    expect(getEvalIaSurfaceReference("S5").dependsOn).toEqual(["S3"]);
    expect(getEvalIaSurfaceReference("S6").dependsOn).toEqual([
      "S2",
      "S3",
      "S4",
    ]);
  });
});
