import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CiMetadataDisplay } from "../ci-metadata-display";

const metadata = {
  branch: "main",
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  runUrl: "https://github.com/mcpjam/inspector/actions/runs/123",
};

describe("CiMetadataDisplay", () => {
  it("renders links in full mode when interactive is true", () => {
    render(<CiMetadataDisplay ciMetadata={metadata} compact interactive />);

    expect(screen.getAllByRole("link").length).toBeGreaterThanOrEqual(3);
  });

  it("renders non-interactive badges in full mode when interactive is false", () => {
    render(
      <CiMetadataDisplay ciMetadata={metadata} compact interactive={false} />,
    );

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("aaaaaaa")).toBeTruthy();
    expect(screen.getByText("Pipeline")).toBeTruthy();
  });

  it("renders a single CI chip in chip mode", () => {
    render(
      <CiMetadataDisplay
        ciMetadata={metadata}
        compact
        compactMode="chip"
        interactive={false}
      />,
    );

    expect(screen.getByText("CI")).toBeTruthy();
    expect(screen.queryByText("main")).toBeNull();
    expect(screen.queryByText("aaaaaaa")).toBeNull();
  });
});
