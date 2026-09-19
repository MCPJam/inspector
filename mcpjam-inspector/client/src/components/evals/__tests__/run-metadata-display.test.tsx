import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { RunMetadataDisplay } from "../run-metadata-display";
import type { EvalSuiteRun } from "../types";

describe("persisted run metadata", () => {
  it("renders the authored name, run tags and flat metadata as text", () => {
    render(
      <RunMetadataDisplay
        run={
          {
            runNumber: 42,
            name: "Release candidate",
            tags: ["enterprise"],
            runMetadata: {
              owner: "<script>bad()</script>",
              build: 7,
              dirty: false,
            },
          } as unknown as EvalSuiteRun
        }
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Release candidate" }),
    ).toBeTruthy();
    expect(screen.getByText("enterprise")).toBeTruthy();
    expect(screen.getByText("<script>bad()</script>")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
  });
  it("uses the run number for metadata on an unnamed historical run", () => {
    render(
      <RunMetadataDisplay
        run={{ runNumber: 42, tags: ["legacy"] } as unknown as EvalSuiteRun}
      />,
    );
    expect(screen.getByRole("heading", { name: "Run #42" })).toBeTruthy();
  });
});
