import { describe, expect, it } from "vitest";
import { evalStatusLeftBorderClasses } from "../helpers";

describe("evalStatusLeftBorderClasses", () => {
  it("paints a grading run's rail amber, like a running one", () => {
    // A held run's badge is amber; a muted rail beside it reads as a
    // different state than the one the badge names.
    expect(evalStatusLeftBorderClasses("grading")).toBe("border-l-warning/50");
    expect(evalStatusLeftBorderClasses("grading")).toBe(
      evalStatusLeftBorderClasses("running"),
    );
  });

  it("keeps running on the warning rail", () => {
    expect(evalStatusLeftBorderClasses("running")).toBe("border-l-warning/50");
  });

  it("does not promote unknown statuses to the warning rail", () => {
    expect(evalStatusLeftBorderClasses("nonsense")).toBe(
      "border-l-muted-foreground/50",
    );
  });
});

describe("evalStatusMiniBarClasses", () => {
  it("pulses a grading run like a running one, never the muted default", async () => {
    const { evalStatusMiniBarClasses } = await import("../helpers");
    expect(evalStatusMiniBarClasses("grading")).toBe(
      evalStatusMiniBarClasses("running"),
    );
    expect(evalStatusMiniBarClasses("grading")).toContain("bg-warning");
  });
});
