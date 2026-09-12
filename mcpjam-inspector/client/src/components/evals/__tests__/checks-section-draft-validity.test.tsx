/**
 * A raw-JSON draft that does not parse is never written into a predicate, so
 * `areAllChecksValid` cannot see it. `ChecksSection` reports it through
 * `onDraftValidityChange` instead; these cases pin what that reports, and
 * when.
 */
import { fireEvent, render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Predicate } from "@mcpjam/sdk/browser";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));

import { ChecksSection } from "../checks-section";

function Harness({
  initial,
  onDraftValidityChange,
  onValue,
}: {
  initial: Predicate[];
  onDraftValidityChange: (hasInvalidDraft: boolean) => void;
  onValue?: (next: Predicate[]) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ChecksSection
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
      onDraftValidityChange={onDraftValidityChange}
    />
  );
}

const toolCalledWith = (toolName: string): Predicate =>
  ({ type: "toolCalledWith", toolName, args: { args: {} } }) as Predicate;

async function switchToRawJson(index = 0) {
  const toggles = screen.getAllByRole("switch", {
    name: "Use raw JSON editor",
  });
  await userEvent.click(toggles[index]!);
  return screen.getAllByLabelText(/Expected args \(JSON\)/)[index]!;
}

describe("ChecksSection raw-JSON draft validity", () => {
  it("reports no invalid draft on mount", () => {
    const onDraftValidityChange = vi.fn();
    render(
      <Harness
        initial={[toolCalledWith("search")]}
        onDraftValidityChange={onDraftValidityChange}
      />,
    );
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("reports an invalid draft on a fresh check, without writing it through", async () => {
    const onDraftValidityChange = vi.fn();
    const onValue = vi.fn();
    render(
      <Harness
        initial={[toolCalledWith("")]}
        onDraftValidityChange={onDraftValidityChange}
        onValue={onValue}
      />,
    );
    const textarea = await switchToRawJson();
    fireEvent.change(textarea, { target: { value: '{string: "oliwis"}' } });

    expect(onDraftValidityChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText(/Expected property name/)).toBeInTheDocument();
    // The predicate still holds the last args that parsed.
    expect(onValue).not.toHaveBeenCalled();
  });

  it("stays invalid when an unrelated field is edited", async () => {
    const onDraftValidityChange = vi.fn();
    render(
      <Harness
        initial={[toolCalledWith("")]}
        onDraftValidityChange={onDraftValidityChange}
      />,
    );
    const textarea = await switchToRawJson();
    fireEvent.change(textarea, { target: { value: '{string: "oliwis"}' } });
    onDraftValidityChange.mockClear();

    fireEvent.change(screen.getByLabelText("Tool"), {
      target: { value: "search" },
    });

    // The predicate changed and re-rendered the row; the draft is still there
    // and still does not parse.
    expect(onDraftValidityChange).not.toHaveBeenCalledWith(false);
    expect(textarea).toHaveValue('{string: "oliwis"}');
    expect(screen.getByText(/Expected property name/)).toBeInTheDocument();
  });

  it("reports valid again once the JSON parses", async () => {
    const onDraftValidityChange = vi.fn();
    const onValue = vi.fn();
    render(
      <Harness
        initial={[toolCalledWith("search")]}
        onDraftValidityChange={onDraftValidityChange}
        onValue={onValue}
      />,
    );
    const textarea = await switchToRawJson();
    fireEvent.change(textarea, { target: { value: '{string: "oliwis"}' } });
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(true);

    fireEvent.change(textarea, { target: { value: '{"string": "oliwis"}' } });
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(false);
    expect(onValue).toHaveBeenLastCalledWith([
      expect.objectContaining({
        toolName: "search",
        args: expect.objectContaining({ args: { string: "oliwis" } }),
      }),
    ]);
  });

  it("treats a non-object root as invalid", async () => {
    const onDraftValidityChange = vi.fn();
    render(
      <Harness
        initial={[toolCalledWith("search")]}
        onDraftValidityChange={onDraftValidityChange}
      />,
    );
    const textarea = await switchToRawJson();
    fireEvent.change(textarea, { target: { value: "[1, 2]" } });
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText("Expected a JSON object")).toBeInTheDocument();
  });

  it("one unparsable row among valid rows keeps the section invalid", async () => {
    const onDraftValidityChange = vi.fn();
    render(
      <Harness
        initial={[toolCalledWith("search"), toolCalledWith("fetch")]}
        onDraftValidityChange={onDraftValidityChange}
      />,
    );
    const first = await switchToRawJson(0);
    const second = await switchToRawJson(1);
    fireEvent.change(first, { target: { value: "{" } });
    fireEvent.change(second, { target: { value: "{" } });
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(true);
    onDraftValidityChange.mockClear();

    fireEvent.change(second, { target: { value: '{"a": 1}' } });
    // Still one bad row.
    expect(onDraftValidityChange).not.toHaveBeenCalled();

    fireEvent.change(first, { target: { value: "{}" } });
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("turning Raw JSON off discards the unparsable draft and clears the block", async () => {
    const onDraftValidityChange = vi.fn();
    render(
      <Harness
        initial={[toolCalledWith("search")]}
        onDraftValidityChange={onDraftValidityChange}
      />,
    );
    const textarea = await switchToRawJson();
    fireEvent.change(textarea, { target: { value: "{" } });
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(true);

    await userEvent.click(
      screen.getByRole("switch", { name: "Use raw JSON editor" }),
    );
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("removing the row with the bad draft clears the block", async () => {
    const onDraftValidityChange = vi.fn();
    render(
      <Harness
        initial={[toolCalledWith("search")]}
        onDraftValidityChange={onDraftValidityChange}
      />,
    );
    const textarea = await switchToRawJson();
    fireEvent.change(textarea, { target: { value: "{" } });
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      await userEvent.click(
        screen.getByRole("button", { name: "Remove check" }),
      );
    });
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("covers the tool-result schema editor the same way", () => {
    const onDraftValidityChange = vi.fn();
    render(
      <Harness
        initial={[{ type: "toolResultMatchesSchema", schema: {} } as Predicate]}
        onDraftValidityChange={onDraftValidityChange}
      />,
    );
    const textarea = screen.getByLabelText(/JSON Schema the result must match/);
    fireEvent.change(textarea, { target: { value: '{"type": ' } });
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText(/Not valid JSON/)).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: '{"type": "object"}' } });
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(false);
  });
});
