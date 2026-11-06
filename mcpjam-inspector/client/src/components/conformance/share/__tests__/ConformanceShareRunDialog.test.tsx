import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConformanceShareRunDialog } from "../ConformanceShareRunDialog";
import { sharePostText, shareCardDataFromRun } from "../share-run-content";

const mocks = vi.hoisted(() => ({
  run: undefined as unknown,
  settings: undefined as unknown,
  toPng: vi.fn(),
}));

vi.mock("@/lib/artifact-urls", () => ({
  useArtifactQuery: () => mocks.run,
}));
vi.mock("@/hooks/useShares", () => ({
  useShareSettings: () => ({ settings: mocks.settings, isLoading: false }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/components/sharing/ResourceSharePanel", () => ({
  ResourceSharePanel: () => <div data-testid="access-settings-panel" />,
}));
vi.mock("html-to-image", () => ({ toPng: mocks.toPng }));

const RUN = {
  score: 85.7,
  outcome: "incomplete",
  applicable: 28,
  passed: 24,
  failed: 0,
  couldNotRun: 4,
  notApplicable: 2,
  advisoryCount: 0,
  protocolVersion: "2025-11-25",
  reports: [
    {
      suiteKind: "protocol",
      applicable: 16,
      passed: 16,
      failed: 0,
      couldNotRun: 0,
    },
    { suiteKind: "tasks", applicable: 5, passed: 1, failed: 0, couldNotRun: 4 },
  ],
};

function linkSettings(mode: string) {
  return { mode, link: { token: "V1StGXR8_Z5jdHi6B-myT" }, members: [] };
}

function renderDialog(onOpenChange = vi.fn()) {
  render(
    <ConformanceShareRunDialog
      runId="run_1"
      serverName="amazon-test"
      finished
      open
      onOpenChange={onOpenChange}
    />,
  );
  return onOpenChange;
}

describe("ConformanceShareRunDialog", () => {
  beforeEach(() => {
    mocks.run = RUN;
    mocks.settings = linkSettings("anyone_with_link");
    vi.spyOn(window, "open").mockImplementation(() => null);
    // Fonts are inlined for the export; jsdom has no font files to fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["font"]))),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.toPng.mockReset();
  });

  it("shows the run's card with its four actions", () => {
    renderDialog();
    expect(screen.getByText("Share conformance run")).toBeInTheDocument();
    expect(screen.getByTestId("conformance-share-card")).toBeInTheDocument();
    expect(screen.getByText("amazon-test")).toBeInTheDocument();
    expect(screen.getByTestId("conformance-share-download")).toBeEnabled();
    expect(screen.getByTestId("conformance-share-copy-link")).toBeEnabled();
    expect(screen.getByTestId("conformance-share-post-x")).toBeEnabled();
    expect(screen.getByTestId("conformance-share-post-linkedin")).toBeEnabled();
  });

  it("posts the run's link to X with its score in the text", () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("conformance-share-post-x"));
    const url = new URL(vi.mocked(window.open).mock.calls[0]![0] as string);
    expect(url.origin).toBe("https://x.com");
    expect(url.searchParams.get("url")).toBe(
      `${window.location.origin}/conformance/shared/V1StGXR8_Z5jdHi6B-myT`,
    );
    expect(url.searchParams.get("text")).toContain("85.7/100");
  });

  it("shares the run's link on LinkedIn", () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("conformance-share-post-linkedin"));
    const url = new URL(vi.mocked(window.open).mock.calls[0]![0] as string);
    expect(url.host).toBe("www.linkedin.com");
    expect(url.searchParams.get("url")).toContain("/conformance/shared/");
  });

  it("says a team-only link will not show the card on X or LinkedIn", () => {
    mocks.settings = linkSettings("project_members");
    renderDialog();
    expect(
      screen.getByTestId("conformance-share-restricted-note"),
    ).toHaveTextContent("Only team members can open this link");
  });

  it("waits for a link before copying or posting", () => {
    mocks.settings = { mode: "project_members", link: null, members: [] };
    renderDialog();
    expect(screen.getByTestId("conformance-share-copy-link")).toBeDisabled();
    expect(screen.getByTestId("conformance-share-post-x")).toBeDisabled();
    expect(screen.getByTestId("conformance-share-download")).toBeEnabled();
  });

  it("opens the access settings from the Copy link row", async () => {
    const onOpenChange = renderDialog();
    fireEvent.click(screen.getByTestId("conformance-share-edit-access"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(
      await screen.findByTestId("access-settings-panel"),
    ).toBeInTheDocument();
  });

  it("saves the card as a PNG", async () => {
    mocks.toPng.mockResolvedValue("data:image/png;base64,AAAA");
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    renderDialog();
    fireEvent.click(screen.getByTestId("conformance-share-download"));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("mcp-conformance-amazon-test-85.7.png");
    expect(mocks.toPng.mock.calls[0]![1]).toMatchObject({
      width: 1200,
      height: 630,
    });
  });

  it("has no card for a run with nothing applicable", () => {
    mocks.run = { ...RUN, applicable: 0 };
    renderDialog();
    expect(screen.queryByTestId("conformance-share-card")).toBeNull();
    expect(screen.getByTestId("conformance-share-download")).toBeDisabled();
  });
});

describe("sharePostText", () => {
  it("carries the score with its denominator and protocol version", () => {
    const data = shareCardDataFromRun(RUN, { serverName: "amazon-test" })!;
    expect(sharePostText(data)).toBe(
      "amazon-test scored 85.7/100 on MCP conformance (24/28 checks, MCP 2025-11-25) with @mcpjam.",
    );
  });
});
