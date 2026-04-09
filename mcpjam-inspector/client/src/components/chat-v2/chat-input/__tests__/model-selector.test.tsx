import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSelector } from "../model-selector";
import type { ModelDefinition } from "@/shared/types.js";

// Lightweight mock for ProviderLogo — avoids pulling in theme stores
vi.mock("../model/provider-logo", () => ({
  ProviderLogo: ({ provider }: { provider: string }) => (
    <span data-testid={`logo-${provider}`} />
  ),
}));

// Mock ConfirmChatResetDialog
vi.mock("../dialogs/confirm-chat-reset-dialog", () => ({
  ConfirmChatResetDialog: () => null,
}));

// Mock tooltip to avoid Radix portal issues in jsdom
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
    asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

const mcpjamModel: ModelDefinition = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5",
  provider: "anthropic",
};

const userModel: ModelDefinition = {
  id: "my-custom-model",
  name: "My Custom Model",
  provider: "openai",
};

describe("ModelSelector — no auth gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT disable MCPJam models when user is unauthenticated", async () => {
    const onModelChange = vi.fn();
    render(
      <ModelSelector
        currentModel={userModel}
        availableModels={[mcpjamModel, userModel]}
        onModelChange={onModelChange}
        hasMessages={false}
      />,
    );

    // Open the dropdown
    const trigger = screen.getByRole("button");
    await userEvent.click(trigger);

    await screen.findByText("Anthropic");

    // Command palette uses cmdk items (data-slot="command-item"), not menuitem
    const modelItem = await screen.findByText("Claude Haiku 4.5");
    const commandItem = modelItem.closest('[data-slot="command-item"]');
    expect(commandItem).not.toBeNull();
    expect(commandItem!.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("allows selecting MCPJam models when unauthenticated", async () => {
    const onModelChange = vi.fn();
    render(
      <ModelSelector
        currentModel={userModel}
        availableModels={[mcpjamModel, userModel]}
        onModelChange={onModelChange}
        hasMessages={false}
      />,
    );

    const trigger = screen.getByRole("button");
    await userEvent.click(trigger);

    const subTrigger = await screen.findByText("Anthropic");
    await userEvent.click(subTrigger);

    const modelItem = await screen.findByText("Claude Haiku 4.5");
    await userEvent.click(modelItem);

    expect(onModelChange).toHaveBeenCalledWith(mcpjamModel);
  });
});
