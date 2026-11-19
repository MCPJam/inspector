import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HostListItem } from "@/hooks/useClients";
import { ClientMultiSelect } from "../client-multi-select";

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: "light" }) => unknown) =>
    selector({ themeMode: "light" }),
}));

const host = (hostId: string, name: string) =>
  ({
    hostId,
    name,
    hostConfigId: `cfg-${hostId}`,
    modelId: "m",
  }) as HostListItem;

const hosts = [
  host("h1", "Claude"),
  host("h2", "ChatGPT"),
  host("h3", "Cursor"),
];

describe("ClientMultiSelect", () => {
  it("summarizes the selection on the trigger", () => {
    render(
      <ClientMultiSelect
        hosts={hosts}
        value={["h1", "h2"]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("client-multi-select-trigger")).toHaveTextContent(
      "Claude +1",
    );
  });

  it("adds and removes clients without closing", async () => {
    const onChange = vi.fn();
    render(
      <ClientMultiSelect hosts={hosts} value={["h1"]} onChange={onChange} />,
    );

    await userEvent.click(screen.getByTestId("client-multi-select-trigger"));
    await userEvent.click(screen.getByTestId("client-multi-select-option-h3"));
    expect(onChange).toHaveBeenLastCalledWith(["h1", "h3"]);

    await userEvent.click(screen.getByTestId("client-multi-select-option-h1"));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByTestId("client-multi-select-option-h2")).toBeVisible();
  });
});
