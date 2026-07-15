import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import {
  SdkEvalQuickstart,
  SDK_EVAL_QUICKSTART_INSTALL,
  SDK_EVAL_QUICKSTART_ENV,
  SDK_EVAL_QUICKSTART_DOTENV,
  SDK_EVAL_QUICKSTART_RUN,
  buildSdkEvalQuickstartDotenv,
} from "../sdk-eval-quickstart";

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(() => Promise.resolve(true)),
}));

describe("SdkEvalQuickstart", () => {
  it("renders all four step cards with content visible", () => {
    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    expect(
      screen.getByText("Create a project and install the SDK")
    ).toBeTruthy();
    expect(screen.getByText("Set environment")).toBeTruthy();
    expect(
      screen.getByText("Add mcp-eval.quickstart.test.ts to your project")
    ).toBeTruthy();
    expect(screen.getByText("Run the demo test")).toBeTruthy();

    // All content visible without expansion
    expect(document.body.textContent).toContain("npm install @mcpjam/sdk");
    expect(document.body.textContent).toContain("learn.mcpjam.com");
    expect(document.body.textContent).toContain("openai");
    expect(
      screen.getAllByText(/mcp-eval\.quickstart\.test\.ts/).length
    ).toBeGreaterThanOrEqual(1);

    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/EvalTest/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/evalTest\.run/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/evalTest\.accuracy/);
  });

  it("wires sk_-keyed reporting and never the retired mcpjam_ keys", () => {
    renderWithProviders(<SdkEvalQuickstart projectId="ws-1" />);

    // Reporting runs on MCPJam API keys (sk_) — same env var, new key kind.
    expect(SDK_EVAL_QUICKSTART_ENV).toMatch(/MCPJAM_API_KEY=<your sk_/);
    expect(SDK_EVAL_QUICKSTART_DOTENV).toMatch(/MCPJAM_API_KEY=<your sk_/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/mcpjam:/);
    expect(SDK_EVAL_QUICKSTART_RUN).toMatch(/suiteName/);

    // The quickstart targets the current project via MCPJAM_PROJECT_ID.
    expect(buildSdkEvalQuickstartDotenv("ws-1")).toContain(
      "MCPJAM_PROJECT_ID=ws-1"
    );
    expect(buildSdkEvalQuickstartDotenv(null)).not.toContain(
      "MCPJAM_PROJECT_ID"
    );
    expect(document.body.textContent).toContain("MCPJAM_PROJECT_ID=ws-1");

    // The retired key kind must never resurface.
    expect(document.body.textContent).not.toContain("mcpjam_");
    // The quickstart never mints keys in-app; users create sk_ keys in
    // Settings → API keys.
    expect(
      screen.queryByRole("button", { name: "Generate API key" })
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

    expect(copyToClipboard).toHaveBeenCalledWith(
      buildSdkEvalQuickstartDotenv("ws-1")
    );
  });
});
