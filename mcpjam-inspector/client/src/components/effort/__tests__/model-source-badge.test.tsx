import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import type { ModelDefinition } from "@/shared/types";
import {
  ModelSourceBadge,
  modelSourceLabel,
  type ModelSourceBadgeProps,
} from "../model-source-badge";

const FALLBACK = { provider: "none", model: "none" } as const;

const HOSTED: ModelSelection = {
  modelId: "anthropic/claude-haiku-4.5",
  source: "hosted",
  fallback: FALLBACK,
};
const ORG: ModelSelection = {
  modelId: "anthropic/claude-haiku-4.5",
  source: "org",
  connectionRef: { kind: "orgProvider", id: "prov_1" },
  fallback: FALLBACK,
};
const LOCAL: ModelSelection = {
  modelId: "openai/gpt-5",
  source: "local",
  connectionRef: { kind: "localProvider", providerKey: "openai" },
  fallback: FALLBACK,
};
const LOCAL_CUSTOM: ModelSelection = {
  modelId: "custom/llama",
  source: "local",
  connectionRef: {
    kind: "localProvider",
    providerKey: "custom",
    customProviderName: "My vLLM",
  },
  nativeModelId: "llama",
  fallback: FALLBACK,
};

const HOSTED_ROW = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5",
  provider: "anthropic",
  hosted: true,
} as ModelDefinition;
const ORG_ROW = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5 (org)",
  provider: "anthropic",
  hosted: false,
  orgProvider: { id: "prov_1", providerKey: "anthropic" },
} as ModelDefinition;

function renderBadge(props: ModelSourceBadgeProps) {
  return render(
    <TooltipProvider>
      <ModelSourceBadge {...props} />
    </TooltipProvider>,
  );
}

describe("modelSourceLabel", () => {
  it("names MCPJam credits for a hosted selection", () => {
    expect(modelSourceLabel(HOSTED)).toEqual({
      kind: "hosted",
      text: "MCPJam credits",
    });
  });

  it("names the org connection from the org config's display name", () => {
    expect(
      modelSourceLabel(ORG, {
        orgConfig: {
          providers: [
            {
              id: "prov_1",
              providerKey: "anthropic",
              displayName: "Team Anthropic",
              enabled: true,
              hasSecret: true,
            },
          ],
        },
      })?.text,
    ).toBe("Your key · Team Anthropic");
  });

  it("names the org connection from the row the selection resolves to", () => {
    // The hosted twin comes first; the selection still resolves to the org row.
    expect(modelSourceLabel(ORG, { models: [HOSTED_ROW, ORG_ROW] })?.text).toBe(
      "Your key · Anthropic",
    );
  });

  it("does not name a hosted twin as the org connection", () => {
    expect(modelSourceLabel(ORG, { models: [HOSTED_ROW] })?.text).toBe(
      "Your key",
    );
  });

  it("names a local provider, preferring the custom provider name", () => {
    expect(modelSourceLabel(LOCAL)?.text).toBe("Your key · OpenAI");
    expect(modelSourceLabel(LOCAL_CUSTOM)?.text).toBe("Your key · My vLLM");
  });

  it("reads a stored legacy selection as own key only", () => {
    expect(
      modelSourceLabel({ source: "legacy", modelId: "openai/gpt-5" }),
    ).toEqual({ kind: "own-key", text: "Your key" });
  });

  it("claims nothing without a selection", () => {
    expect(modelSourceLabel(undefined)).toBeNull();
    expect(modelSourceLabel(null)).toBeNull();
  });
});

describe("ModelSourceBadge", () => {
  it("renders nothing for an unlabelled row", () => {
    renderBadge({ selection: undefined });
    expect(screen.queryByTestId("model-source-badge")).toBeNull();
  });

  it("renders the label with its source kind", () => {
    renderBadge({ selection: HOSTED });
    const badge = screen.getByTestId("model-source-badge");
    expect(badge).toHaveTextContent("MCPJam credits");
    expect(badge).toHaveAttribute("data-source", "hosted");
    expect(screen.queryByTestId("model-source-backfill-hint")).toBeNull();
  });

  it("shows the set-automatically hint for a backfilled selection and opens the picker", async () => {
    const onReview = vi.fn();
    renderBadge({ selection: LOCAL, selectionOrigin: "backfill", onReview });
    expect(screen.getByTestId("model-source-badge")).toHaveTextContent(
      "Your key · OpenAI",
    );
    expect(screen.getByTestId("model-source-backfill-hint")).toHaveTextContent(
      "Set automatically",
    );
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("shows the hint without a button when the picker cannot open", () => {
    renderBadge({ selection: HOSTED, selectionOrigin: "backfill" });
    expect(
      screen.getByTestId("model-source-backfill-hint"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  });
});
