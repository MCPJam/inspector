import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SHARE_LINK_DENIED_MESSAGE,
  SharedArtifactPage,
} from "../SharedArtifactPage";

describe("SharedArtifactPage", () => {
  it("shows loading and hides children", () => {
    render(
      <SharedArtifactPage title="Shared run" loading>
        <p>secret content</p>
      </SharedArtifactPage>,
    );

    expect(screen.getByText("Shared run")).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("secret content")).not.toBeInTheDocument();
  });

  it("collapses any error to the denied message", () => {
    render(
      <SharedArtifactPage title="Shared run" error="token expired">
        <p>secret content</p>
      </SharedArtifactPage>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      SHARE_LINK_DENIED_MESSAGE,
    );
    expect(screen.queryByText("token expired")).not.toBeInTheDocument();
    expect(screen.queryByText("secret content")).not.toBeInTheDocument();
  });

  it("renders children when not loading and not denied", () => {
    render(
      <SharedArtifactPage title="Shared run">
        <p>artifact body</p>
      </SharedArtifactPage>,
    );

    expect(screen.getByText("artifact body")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders nothing in the body when children are omitted", () => {
    render(<SharedArtifactPage title="Shared run" />);

    expect(screen.getByText("Shared run")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
