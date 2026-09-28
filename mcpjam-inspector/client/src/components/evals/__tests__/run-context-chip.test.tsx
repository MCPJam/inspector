import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunContextChip } from "../run-context-chip";
import { envRun, hostRun } from "./run-context-fixtures";

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));

function renderChip(
  extras: {
    modelLabel?: string | null;
    modelSource?: "client_default" | "override";
  } = {}
) {
  const run = envRun("r1", "env-a", "Staging", 1, {
    effectiveModelId: "google/gemini-2.5-flash",
    ...(extras.modelSource ? { modelSource: extras.modelSource } : {}),
  });
  render(
    <RunContextChip
      run={run}
      modelLabel={extras.modelLabel}
    />
  );
}

describe("RunContextChip model attribution", () => {
  it("falls back to the model-id tail when modelLabel is empty", () => {
    renderChip({ modelLabel: "" });
    const label = screen.getByText("gemini-2.5-flash");
    expect(label).toBeInTheDocument();
    expect(label).toHaveAttribute("title", "gemini-2.5-flash");
  });

  it("falls back to the model-id tail when modelLabel is null", () => {
    renderChip({ modelLabel: null });
    const label = screen.getByText("gemini-2.5-flash");
    expect(label).toBeInTheDocument();
    expect(label).toHaveAttribute("title", "gemini-2.5-flash");
  });

  it("compacts a (Free) catalog label", () => {
    renderChip({
      modelLabel: "Gemini 2.5 Flash (Free)",
      modelSource: "override",
    });
    expect(screen.getByText("Gemini 2.5 Flash")).toHaveAttribute(
      "title",
      "Override · Gemini 2.5 Flash"
    );
  });

  it("prefixes Override and uses foreground text for an override", () => {
    renderChip({
      modelLabel: "Gemini 2.5 Flash",
      modelSource: "override",
    });
    const label = screen.getByText("Gemini 2.5 Flash");
    expect(label).toHaveAttribute("title", "Override · Gemini 2.5 Flash");
    expect(label.className).toMatch(/text-foreground/);
  });

  it("omits a provenance prefix when modelSource is absent", () => {
    renderChip({ modelLabel: "Gemini 2.5 Flash" });
    const label = screen.getByText("Gemini 2.5 Flash");
    expect(label).toHaveAttribute("title", "Gemini 2.5 Flash");
  });

  it("names the model next to a host chip, not only an environment chip", () => {
    render(
      <RunContextChip
        run={hostRun("r-host", "host-1", {
          effectiveModelId: "anthropic/claude-haiku-4.5",
        })}
        hostNamesById={new Map([["host-1", "Claude"]])}
      />,
    );
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("claude-haiku-4.5")).toBeInTheDocument();
  });
});
