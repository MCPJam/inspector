import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  FREE_TIER_MODEL_REASON,
  GUEST_LOCKED_MODEL_REASON,
  OUT_OF_CREDITS_MODEL_REASON,
} from "@/components/chat-v2/shared/available-models";
import type { ModelDefinition } from "@/shared/types";
import { needsSignIn, signInModelNotice } from "../sign-in-model-notice";

const sonnet: ModelDefinition = {
  id: "anthropic/claude-sonnet-4.5",
  name: "Claude Sonnet 4.5",
  provider: "anthropic",
  hosted: true,
};

describe("sign-in model notice", () => {
  it("only treats guest and free-tier locks as needing sign-in", () => {
    expect(needsSignIn(sonnet)).toBe(false);
    expect(
      needsSignIn({
        ...sonnet,
        disabled: true,
        disabledReason: GUEST_LOCKED_MODEL_REASON,
      }),
    ).toBe(true);
    expect(
      needsSignIn({
        ...sonnet,
        disabled: true,
        disabledReason: FREE_TIER_MODEL_REASON,
      }),
    ).toBe(true);
    expect(
      needsSignIn({
        ...sonnet,
        disabled: true,
        disabledReason: OUT_OF_CREDITS_MODEL_REASON,
      }),
    ).toBe(false);
  });

  it("names the locked model in a single chat", () => {
    render(
      <>
        {signInModelNotice({
          model: {
            ...sonnet,
            disabled: true,
            disabledReason: GUEST_LOCKED_MODEL_REASON,
          },
        })}
      </>,
    );
    expect(screen.getByTestId("sign-in-model-notice").textContent).toContain(
      "Claude Sonnet 4.5 needs an account.",
    );
  });

  it("names each locked client in a comparison", () => {
    render(
      <>
        {signInModelNotice({
          clients: [{ clientName: "Cursor", modelName: "Claude Sonnet 4.5" }],
        })}
      </>,
    );
    expect(screen.getByTestId("sign-in-model-notice").textContent).toContain(
      "Cursor can't run. Its model, Claude Sonnet 4.5, needs an account.",
    );
  });

  it("renders nothing when no model needs sign-in", () => {
    expect(signInModelNotice({ model: sonnet })).toBeNull();
    expect(signInModelNotice({ clients: [] })).toBeNull();
  });
});
