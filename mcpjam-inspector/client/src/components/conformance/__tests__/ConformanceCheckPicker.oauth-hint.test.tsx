import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConformanceCheckPicker } from "../ConformanceCheckPicker";

const callbackUrl = `${window.location.origin}/oauth/callback/debug`;

describe("ConformanceCheckPicker OAuth callback hint", () => {
  it("shows the callback URL to allow while OAuth is picked", () => {
    render(
      <ConformanceCheckPicker
        versionPin="2025-11-25"
        selection={{}}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText(callbackUrl)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy callback URL" }),
    ).toBeInTheDocument();
  });

  it("hides it when OAuth is not picked", () => {
    render(
      <ConformanceCheckPicker
        versionPin="2025-11-25"
        selection={{ oauth: false }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText(callbackUrl)).not.toBeInTheDocument();
  });
});
