import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClientSupportPillView } from "../ClientSupportPill";
import type { CompatVerdict, HostCompatReport } from "@/lib/host-compat/types";

function makeReport(
  hostId: string,
  verdict: CompatVerdict = "works",
  logos: Partial<Pick<HostCompatReport, "logoSrc" | "logoSrcByTheme">> = {},
): HostCompatReport {
  return {
    hostId,
    hostLabel: hostId,
    verdict,
    provenance: "observed",
    lanes: {
      apps: { verdict, provenance: "observed" },
      server: { verdict, provenance: "observed" },
    },
    findings: [],
    logoSrc: logos.logoSrc ?? `/${hostId}.png`,
    logoSrcByTheme: logos.logoSrcByTheme,
  };
}

const themedGoose = makeReport("goose", "works", {
  logoSrc: "/goose_light.png",
  logoSrcByTheme: { light: "/goose_light.png", dark: "/goose_dark.png" },
});

describe("ClientSupportPillView", () => {
  it("counts supporters and caps the logo stack at three", () => {
    render(
      <ClientSupportPillView
        serverName="acme"
        reports={[
          makeReport("chatgpt"),
          makeReport("claude"),
          makeReport("vscode"),
          makeReport("n8n"),
          makeReport("slack"),
        ]}
      />,
    );
    expect(screen.getByText("Supported by 5")).toBeTruthy();
    expect(document.querySelectorAll("img").length).toBe(3);
  });

  it("selects the dark mark for themed hosts when the theme is dark", () => {
    // Regression guard: the wrapper used to omit themeMode, so the view fell
    // back to "light" and rendered a light-on-dark logo in dark mode.
    const { unmount } = render(
      <ClientSupportPillView
        serverName="acme"
        reports={[themedGoose]}
        themeMode="dark"
      />,
    );
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "/goose_dark.png",
    );
    unmount();

    render(
      <ClientSupportPillView
        serverName="acme"
        reports={[themedGoose]}
        themeMode="light"
      />,
    );
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "/goose_light.png",
    );
  });

  it("shows the destructive empty state when nothing supports the server", () => {
    render(
      <ClientSupportPillView
        serverName="acme"
        reports={[
          makeReport("cursor", "blocked"),
          makeReport("n8n", "unknown"),
        ]}
      />,
    );
    expect(screen.getByText("No clients support this server")).toBeTruthy();
    expect(document.querySelectorAll("img").length).toBe(0);
    const pill = screen.getByLabelText(/^Client support for acme:/);
    expect(pill.className).toContain("bg-destructive/10");
    expect(pill.className).toContain("border-destructive/40");
  });

  it("does not claim zero support while analysis is still in flight", () => {
    // Mid-analysis every report is absent, which would otherwise look
    // identical to "nothing supports this" and show up in red.
    render(
      <ClientSupportPillView
        serverName="acme"
        reports={[]}
        analysisStatus="analyzing"
      />,
    );
    expect(screen.queryByText("No clients support this server")).toBeNull();
    expect(screen.getByText("Checking compatibility…")).toBeTruthy();
    const pill = screen.getByLabelText(/^Client support for acme:/);
    expect(pill.className).not.toContain("bg-destructive/10");
  });

  it("does not claim zero support when the compat check failed", () => {
    render(
      <ClientSupportPillView
        serverName="acme"
        reports={[]}
        analysisStatus="failed"
      />,
    );
    expect(screen.getByText("Compatibility checks unavailable")).toBeTruthy();
    const pill = screen.getByLabelText(/^Client support for acme:/);
    expect(pill.className).not.toContain("bg-destructive/10");
  });

  it("is a button that opens details when a handler is given", () => {
    const onOpenDetails = vi.fn();
    render(
      <ClientSupportPillView
        serverName="acme"
        reports={[makeReport("chatgpt")]}
        onOpenDetails={onOpenDetails}
      />,
    );
    const pill = screen.getByRole("button", {
      name: /^Client support for acme:/,
    });
    fireEvent.click(pill);
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
  });

  it("renders a non-interactive pill when no handler is given", () => {
    render(
      <ClientSupportPillView
        serverName="acme"
        reports={[makeReport("chatgpt")]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /^Client support for acme:/ }),
    ).toBeNull();
    expect(screen.getByLabelText(/^Client support for acme:/)).toBeTruthy();
  });

  it("labels the pill with the full compat rollup, not just the count", () => {
    // A bare `blocked` verdict carries no color (getCompatDisplayStatus
    // returns null without a finding to justify it), so the unsupported
    // tally needs a real blocker finding — the shape the engine emits.
    const blockedCursor = makeReport("cursor", "blocked");
    blockedCursor.findings = [
      {
        code: "app_only_unrenderable",
        severity: "blocker",
        title: "Widget-only tool can't render here",
        detail: "This host renders neither MCP Apps nor OpenAI Apps.",
        lane: "apps",
        provenance: "observed",
        tools: ["draw"],
      },
    ];
    render(
      <ClientSupportPillView
        serverName="acme"
        reports={[makeReport("chatgpt"), blockedCursor]}
      />,
    );
    expect(
      screen.getByLabelText(
        "Client support for acme: supported in 1 · unsupported in 1",
      ),
    ).toBeTruthy();
  });
});
