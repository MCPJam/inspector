import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComputerStatusChip } from "../ComputerStatusChip";
import type { ComputerStatus } from "@/hooks/useProjectComputer";

function label(status: ComputerStatus | null | undefined): string {
  // Scope to this render's own container so repeated renders in one test
  // don't collide in the shared document body.
  return (
    render(<ComputerStatusChip status={status} />).container.textContent ?? ""
  );
}

describe("ComputerStatusChip", () => {
  it("renders a loading chip while undefined and a no-computer chip for null", () => {
    expect(label(undefined)).toMatch(/Loading/i);
    expect(label(null)).toMatch(/No computer/i);
  });

  it("collapses warming states and labels ready/asleep/error", () => {
    expect(label("provisioning")).toBe("Starting…");
    expect(label("requested")).toBe("Starting…");
    expect(label("waking")).toBe("Waking…");
    expect(label("ready")).toBe("Ready");
    expect(label("hibernating")).toBe("Asleep");
    expect(label("error")).toBe("Error");
  });
});
