import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThinkingIndicator } from "../shared/thinking-indicator";
import { SandboxHostStyleProvider } from "@/contexts/sandbox-host-style-context";
import type { ModelDefinition } from "@/shared/types";

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: "light" }) => unknown) =>
    selector({ themeMode: "light" }),
}));

vi.mock("@/components/chat-v2/shared/chat-helpers", () => ({
  getProviderLogoFromModel: () => "/provider-logo.png",
}));

describe("ThinkingIndicator", () => {
  const defaultModel: ModelDefinition = {
    id: "gpt-4",
    name: "GPT-4",
    provider: "openai",
    contextWindow: 8192,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
  };

  it("renders the provider logo outside sandboxes", () => {
    render(<ThinkingIndicator model={defaultModel} />);

    expect(screen.getByRole("img")).toHaveAttribute("alt", "gpt-4 logo");
  });

  it("renders a neutral placeholder inside sandboxes", () => {
    render(
      <SandboxHostStyleProvider value="chatgpt">
        <ThinkingIndicator model={defaultModel} />
      </SandboxHostStyleProvider>,
    );

    expect(screen.getByLabelText("Assistant")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
