import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConformanceShareRunDialog } from "../ConformanceShareRunDialog";
import { sharePostText, shareCardDataFromRun } from "../share-run-content";

const mocks = vi.hoisted(() => ({
  run: undefined as unknown,
  settings: undefined as unknown,
  exportPng: vi.fn(),
  toastError: vi.fn(),
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
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: mocks.toastError },
}));
// jsdom draws no canvas; the export itself is a browser primitive.
vi.mock("../ShareCardPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ShareCardPreview")>()),
  exportShareCardPng: mocks.exportPng,
}));

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
    // jsdom has no object URLs; the download only hands one to an anchor.
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:card"),
      revokeObjectURL: vi.fn(),
    });
    // Fonts are inlined for the export; jsdom has no font files to fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["font"]))),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.exportPng.mockReset();
    mocks.toastError.mockReset();
  });

  it("shows the run's card with its four actions", async () => {
    renderDialog();
    expect(screen.getByText("Share conformance run")).toBeInTheDocument();
    expect(screen.getByTestId("conformance-share-card")).toBeInTheDocument();
    const image = await screen.findByRole("img", {
      name: /^amazon-test scored 85\.7\/100 on MCP conformance\. Incomplete run\./,
    });
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
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

  it("waits for a link before copying or posting", async () => {
    mocks.settings = { mode: "project_members", link: null, members: [] };
    renderDialog();
    expect(screen.getByTestId("conformance-share-copy-link")).toBeDisabled();
    expect(screen.getByTestId("conformance-share-post-x")).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByTestId("conformance-share-download")).toBeEnabled(),
    );
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
    mocks.exportPng.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    renderDialog();
    const download = screen.getByTestId("conformance-share-download");
    await waitFor(() => expect(download).toBeEnabled());
    fireEvent.click(download);
    await waitFor(() => expect(click).toHaveBeenCalled());
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("mcp-conformance-amazon-test-85.7.png");
    expect(anchor.href).toBe("blob:card");
    // The same SVG the dialog shows is what gets drawn into the PNG.
    const svg = mocks.exportPng.mock.calls[0]![0] as string;
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain(">amazon-test</text>");
    // Outside the hosted app, the card names no address.
    expect(svg).not.toContain(window.location.hostname);
  });

  it("says when the image could not be saved", async () => {
    mocks.exportPng.mockRejectedValue(new Error("no canvas"));
    renderDialog();
    const download = screen.getByTestId("conformance-share-download");
    await waitFor(() => expect(download).toBeEnabled());
    fireEvent.click(download);
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't save the image. Try again.",
      ),
    );
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
