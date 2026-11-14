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
      "Sign in to use Claude Sonnet 4.5, or choose another model.",
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
      "Cursor can't run Claude Sonnet 4.5. Sign in to use this model, or choose another model in Connect → Client.",
    );
  });

  it("renders nothing when no model needs sign-in", () => {
    expect(signInModelNotice({ model: sonnet })).toBeNull();
    expect(signInModelNotice({ clients: [] })).toBeNull();
  });
});
