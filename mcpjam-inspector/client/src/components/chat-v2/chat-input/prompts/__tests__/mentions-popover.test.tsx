import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  MentionsPopover,
  scopedMentionToken,
  type MentionComposer,
} from "../mentions-popover";
const item = {
  serverId: "s",
  toolName: "mentions",
  item: {
    type: "resource" as const,
    resourceUri: "fixture://bolt",
    title: "Bolt",
  },
};
const plugin = { serverId: "s", name: "Bits & Bolts Local" };
function composer(overrides: Partial<MentionComposer> = {}): MentionComposer {
  return {
    scope: "one",
    plugins: vi
      .fn()
      .mockResolvedValue([
        plugin,
        { serverId: "other", name: "Parts Library" },
      ]),
    search: vi.fn().mockResolvedValue([item]),
    select: vi.fn(),
    ...overrides,
  };
}
const base = {
  anchor: { x: 20, y: 30 },
  actionTrigger: null,
  setActionTrigger: vi.fn(),
  onPickPlugin: vi.fn(),
  onDismiss: vi.fn(),
};
describe("two-step mention picker", () => {
  it("lists plugins with a mention tool first, filtered by the typed text", async () => {
    const mentions = composer();
    const onPickPlugin = vi.fn();
    const token = { start: 4, end: 7, query: "bit" };
    const { rerender } = render(
      <MentionsPopover
        {...base}
        onPickPlugin={onPickPlugin}
        mentions={mentions}
        token={token}
      />,
    );
    expect(
      await screen.findByRole("option", { name: "Bits & Bolts Local" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Parts Library" })).toBeNull();
    expect(mentions.search).not.toHaveBeenCalled();
    rerender(
      <MentionsPopover
        {...base}
        onPickPlugin={onPickPlugin}
        mentions={mentions}
        token={token}
        actionTrigger="Enter"
      />,
    );
    await waitFor(() =>
      expect(onPickPlugin).toHaveBeenCalledWith(plugin, token),
    );
  });

  it("shows each plugin row's composer icon, and a plain server's own icon", async () => {
    const mentions = composer({
      plugins: vi.fn().mockResolvedValue([
        {
          ...plugin,
          icons: {
            composerIcon: {
              url: "https://cdn.test/composer.png",
              contentType: "image/png",
            },
          },
          serverIcons: [{ src: "https://cdn.test/bits-server.png" }],
        },
        {
          serverId: "other",
          name: "Parts Library",
          serverIcons: [{ src: "https://cdn.test/parts-server.png" }],
        },
      ]),
    });
    render(
      <MentionsPopover
        {...base}
        mentions={mentions}
        token={{ start: 0, end: 1, query: "" }}
      />,
    );
    const icon = async (name: string) =>
      (await screen.findByRole("option", { name })).querySelector("img");
    expect(await icon("Bits & Bolts Local")).toHaveAttribute(
      "src",
      "https://cdn.test/composer.png",
    );
    expect(await icon("Parts Library")).toHaveAttribute(
      "src",
      "https://cdn.test/parts-server.png",
    );
  });
  it("searches only the picked plugin and selects with the keyboard", async () => {
    const mentions = composer();
    const token = { start: 4, end: 16, query: "hex bolt" };
    const props = { ...base, mentions, token, scopedTo: plugin };
    const { rerender } = render(<MentionsPopover {...props} />);
    expect(
      screen.getByText("Bits & Bolts Local · Type to search"),
    ).toBeInTheDocument();
    await screen.findByRole("option", { name: "Bolt" });
    expect(mentions.search).toHaveBeenCalledWith(
      "s",
      "hex bolt",
      expect.any(AbortSignal),
    );
    expect(mentions.plugins).not.toHaveBeenCalled();
    rerender(<MentionsPopover {...props} actionTrigger="Enter" />);
    await waitFor(() =>
      expect(mentions.select).toHaveBeenCalledWith(item, token),
    );
  });

  it("cancels stale searches and ignores late results", async () => {
    let first!: (items: (typeof item)[]) => void;
    const search = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            first = resolve;
          }),
      )
      .mockResolvedValue([{ ...item, item: { ...item.item, title: "Nut" } }]);
    const mentions = composer({ search });
    const props = {
      ...base,
      mentions,
      scopedTo: plugin,
      token: { start: 4, end: 7, query: "bo" },
    };
    const { rerender } = render(<MentionsPopover {...props} />);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    const signal = search.mock.calls[0][2] as AbortSignal;
    rerender(
      <MentionsPopover {...props} token={{ start: 4, end: 7, query: "nu" }} />,
    );
    await screen.findByRole("option", { name: "Nut" });
    expect(signal.aborted).toBe(true);
    await act(async () => first([item]));
    expect(screen.queryByRole("option", { name: "Bolt" })).toBeNull();
  });

  it("renders a scoped failure without selecting a partial result", async () => {
    const mentions = composer({
      search: vi.fn().mockRejectedValue(new Error("failed")),
    });
    render(
      <MentionsPopover
        {...base}
        mentions={mentions}
        scopedTo={plugin}
        token={{ start: 0, end: 1, query: "" }}
      />,
    );
    await screen.findByText("Couldn’t search Bits & Bolts Local. Try again.");
    expect(mentions.select).not.toHaveBeenCalled();
  });

  it("says so when no connected plugin offers mentions", async () => {
    render(
      <MentionsPopover
        {...base}
        mentions={composer({ plugins: vi.fn().mockResolvedValue([]) })}
        token={{ start: 0, end: 1, query: "" }}
      />,
    );
    await screen.findByText("No connected plugin offers mentions.");
  });

  it("closes on Escape through the composer", async () => {
    const onDismiss = vi.fn();
    const props = {
      ...base,
      onDismiss,
      mentions: composer(),
      token: { start: 0, end: 1, query: "" },
    };
    const { rerender } = render(<MentionsPopover {...props} />);
    await screen.findByRole("option", { name: "Bits & Bolts Local" });
    rerender(<MentionsPopover {...props} actionTrigger="Escape" />);
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    fireEvent.keyDown(document.body, { key: "Escape" });
  });
});

describe("scoped mention token", () => {
  it("allows spaces after the plugin's @ on one line", () => {
    expect(scopedMentionToken("Check @hex bolt", 15, 6)).toEqual({
      start: 6,
      end: 15,
      query: "hex bolt",
    });
    expect(scopedMentionToken("Check @hex\nbolt", 15, 6)).toBeUndefined();
    expect(scopedMentionToken("Check hex", 9, 6)).toBeUndefined();
    expect(scopedMentionToken("Check @hex", 5, 6)).toBeUndefined();
  });
});
