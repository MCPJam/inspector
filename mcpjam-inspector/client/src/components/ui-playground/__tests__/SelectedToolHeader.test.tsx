import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectedToolHeader } from "../SelectedToolHeader";

describe("SelectedToolHeader", () => {
  it.each([undefined, "prompt"] as const)(
    "labels the list action for %s",
    async (listLabel) => {
      const onExpand = vi.fn();
      render(
        <SelectedToolHeader
          toolName="selected"
          onExpand={onExpand}
          listLabel={listLabel}
        />,
      );
      const label = `Show full ${listLabel ?? "tool"} list`;
      const back = screen.getByRole("button", { name: label, exact: true });
      expect(back).toHaveAttribute("title", label);
      await userEvent.click(back);
      expect(onExpand).toHaveBeenCalledOnce();
    },
  );
  it("selects by id when two tools share a label", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <SelectedToolHeader
        toolName="submit"
        onExpand={() => {}}
        toolSwitchList={{
          items: [
            {
              id: "https://a.test::submit",
              label: "submit",
              description: "https://a.test",
            },
            {
              id: "https://b.test::submit",
              label: "submit",
              description: "https://b.test",
            },
          ],
          selectedId: "https://a.test::submit",
          onSelect,
        }}
      />,
    );

    await user.click(screen.getByTitle("Switch tool"));
    await user.click(screen.getByText("https://b.test"));

    expect(onSelect).toHaveBeenCalledWith("https://b.test::submit");
    expect(onSelect).not.toHaveBeenCalledWith("https://a.test::submit");
  });
});
