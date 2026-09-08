/**
 * The chain cards stay a three-span mount unless a caller opts into detail.
 *
 * Settings adds a config line; the three existing run mounts pass nothing
 * and must keep rendering the same three spans.
 */

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { StageChainCards } from "../stage-chain-cards";
import type { StageCardView } from "../stage-chain-model";
import { STAGE_CHIP_TONE_CLASS } from "../stage-chain-model";

function card(overrides: Partial<StageCardView> = {}): StageCardView {
  return {
    stage: "selection",
    ordinal: "03",
    label: "Selection",
    chip: {
      kind: "unmeasured",
      label: "Observed by the runner",
      toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
    },
    ...overrides,
  };
}

function spans(container: HTMLElement) {
  return container.querySelector("button")?.querySelectorAll(":scope > span");
}

describe("StageChainCards", () => {
  it("keeps the existing three-span mount when detail is omitted", () => {
    const { container } = render(
      <StageChainCards
        cards={[card()]}
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    expect(spans(container)).toHaveLength(3);
  });

  it("adds a fourth span only when detail is provided", () => {
    const { container } = render(
      <StageChainCards
        cards={[
          card({
            detail: {
              label: "2 gates · 1 warn",
              toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
            },
          }),
        ]}
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    const text = Array.from(spans(container) ?? []).map(
      (node) => node.textContent,
    );
    expect(text).toEqual([
      "03",
      "Selection",
      "Observed by the runner",
      "2 gates · 1 warn",
    ]);
  });
});
