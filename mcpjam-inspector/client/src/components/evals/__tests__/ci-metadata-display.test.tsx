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

  it.each([
    "javascript:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "/pipelines/99",
  ])("never turns %s into a link", (runUrl) => {
    // `runUrl` is a DECLARED label — whoever launched the run chose it. It is
    // also the href of three anchors here, so a `javascript:` value is a
    // script the reader runs by clicking their own run's provenance. The
    // header parser rejects these at the boundary; this covers rows written
    // before it did.
    render(
      <CiMetadataDisplay
        ciMetadata={{ ...metadata, runUrl }}
        compact
        interactive
      />,
    );

    for (const link of screen.queryAllByRole("link")) {
      expect(link.getAttribute("href")).toMatch(/^https?:/);
    }
    // The labels survive; only the linking is withdrawn.
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.queryByText("Pipeline")).toBeNull();
  });
});
