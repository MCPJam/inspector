import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import {
  SdkEvalQuickstart,
  SDK_EVAL_QUICKSTART_INSTALL,
  SDK_EVAL_QUICKSTART_ENV,
  SDK_EVAL_QUICKSTART_DOTENV,
  SDK_EVAL_QUICKSTART_RUN,
} from "../sdk-eval-quickstart";

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
}));

describe("SdkEvalQuickstart", () => {
  it("renders all four step cards with content visible", () => {
    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    expect(
      screen.getByText("Create a project and install the SDK"),
    ).toBeTruthy();
    expect(screen.getByText("Set environment")).toBeTruthy();
    expect(
      screen.getByText("Add mcp-eval.quickstart.test.ts to your project"),
    ).toBeTruthy();
    expect(screen.getByText("Run the demo test")).toBeTruthy();

    // All content visible without expansion
    expect(document.body.textContent).toContain("npm install @mcpjam/sdk");
    expect(document.body.textContent).toContain("learn.mcpjam.com");
    expect(document.body.textContent).toContain("openai");
    expect(
      screen.getAllByText(/mcp-eval\.quickstart\.test\.ts/).length,
    ).toBeGreaterThanOrEqual(1);

    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/EvalTest/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/evalTest\.run/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/evalTest\.accuracy/);
  });

  it("contains no project API key (mcpjam_) wiring — the keys are retired", () => {
    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    expect(document.body.textContent).not.toContain("MCPJAM_API_KEY");
    expect(SDK_EVAL_QUICKSTART_ENV).not.toMatch(/MCPJAM_API_KEY/);
    expect(SDK_EVAL_QUICKSTART_DOTENV).not.toMatch(/MCPJAM_API_KEY/);
    // The demo test must not wire `mcpjam:` reporting — ingestion is gone.
    expect(SDK_EVAL_QUICKSTART_RUN).not.toMatch(/mcpjam:/);
    expect(
      screen.queryByRole("button", { name: "Generate API key" }),
    ).toBeNull();
  });

  it("shows the SDK docs link", () => {
    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    const docsLink = screen.getByRole("link", {
      name: "Learn more and see all providers in the SDK docs",
    });

    expect(docsLink).toHaveAttribute("href", "https://docs.mcpjam.com/sdk");
  });

  it("copies install snippet when copy is triggered", async () => {
    const user = userEvent.setup();
    const { copyToClipboard } = await import("@/lib/clipboard");
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    renderWithProviders(<SdkEvalQuickstart />);

    const installCopy = screen.getByRole("button", {
      name: "Copy install command",
    });
    await user.click(installCopy);

    expect(copyToClipboard).toHaveBeenCalledWith(SDK_EVAL_QUICKSTART_INSTALL);
  });

  it("copies full run snippet when run section copy is triggered", async () => {
    const user = userEvent.setup();
    const { copyToClipboard } = await import("@/lib/clipboard");
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    renderWithProviders(<SdkEvalQuickstart />);

    const runCopy = screen.getByRole("button", {
      name: "Copy quickstart test file",
    });
    await user.click(runCopy);

    expect(copyToClipboard).toHaveBeenCalledWith(SDK_EVAL_QUICKSTART_RUN);
  });

  it("copies dotenv snippet when copy is triggered", async () => {
    const user = userEvent.setup();
    const { copyToClipboard } = await import("@/lib/clipboard");
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    await user.click(screen.getByRole("button", { name: "Copy .env" }));

    expect(copyToClipboard).toHaveBeenCalledWith(SDK_EVAL_QUICKSTART_DOTENV);
  });
});
