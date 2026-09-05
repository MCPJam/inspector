/**
 * The two-tab picker panel — what the popover shows.
 *
 * Purely presentational: it receives rows and calls back. It does NOT know
 * what a connection is (it is handed a resolved dot colour and label), does
 * not fetch, and does not persist. That is what makes it testable without
 * Convex, and what will let it move into `@mcpjam/design-system` once that
 * package can render React in tests — it has no vitest config, no jsdom and
 * no Testing Library today.
 *
 * The load-bearing assertion in here is "renders no expandable control":
 * the nesting BB-142 exists to remove must not come back.
 */
// @vitest-environment jsdom
//
// Per FILE, not per package: this package's `tokens-parity` test reads
// `tokens.css` off disk through `import.meta.url`, and under jsdom that URL
// becomes http:, which `readFileSync` rejects. Switching the whole package
// would break it; this directive leaves it on node, untouched.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { ServerPickerPanel } from "../components/server-picker-panel";

// The package has no setup file and no `globals`, so Testing Library cannot
// register its own auto-cleanup. Do it explicitly.
afterEach(cleanup);

const CONNECTED = { label: "Connected", indicatorClassName: "bg-success" };
const DISCONNECTED = {
  label: "Disconnected",
  indicatorClassName: "bg-muted-foreground",
};
const FAILED = { label: "Failed", indicatorClassName: "bg-destructive" };

function panelProps(overrides: Record<string, unknown> = {}) {
  return {
    tab: "servers" as const,
    onTabChange: vi.fn(),
    servers: [
      { id: "srv_1", name: "Excalidraw (App)", status: CONNECTED },
      { id: "srv_2", name: "Demo (App)", status: CONNECTED },
      {
        id: "srv_3",
        name: "Broken (App)",
        status: DISCONNECTED,
        onConnect: vi.fn(),
      },
    ],
    groups: [
      { id: "g_1", name: "Group 1", serverNames: ["excalidraw", "sample"] },
      { id: "g_2", name: "Group 2", serverNames: ["excalidraw", "sample"] },
    ],
    selectedServerId: null,
    selectedGroupId: null,
    onSelectServer: vi.fn(),
    onSelectGroup: vi.fn(),
    onCreateGroup: vi.fn(),
    ...overrides,
  };
}

describe("ServerPickerPanel — Servers tab", () => {
  it("renders one row per server", () => {
    render(<ServerPickerPanel {...panelProps()} />);
    expect(screen.getByText("Excalidraw (App)")).toBeInTheDocument();
    expect(screen.getByText("Broken (App)")).toBeInTheDocument();
  });

  it("paints the dot with the role token it was handed, and computes none", () => {
    // The panel is given a class, not a colour: an inline colour cannot follow
    // the theme, and mapping a ConnectionStatus is the caller's job anyway, so
    // `failed` can never look like `disconnected` here by accident.
    render(
      <ServerPickerPanel
        {...panelProps({
          servers: [{ id: "s", name: "Broken", status: FAILED }],
        })}
      />,
    );
    const dot = screen.getByTestId("server-status-dot-s");
    expect(dot).toHaveClass("bg-destructive");
    expect(dot.getAttribute("style")).toBeNull();
    expect(dot).toHaveAccessibleName("Failed");
  });

  it("offers Connect only on rows that came with a handler", () => {
    const onConnect = vi.fn();
    render(
      <ServerPickerPanel
        {...panelProps({
          servers: [
            { id: "up", name: "Up", status: CONNECTED },
            { id: "down", name: "Down", status: DISCONNECTED, onConnect },
          ],
        })}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^Connect$/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /^Connect$/ }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("connecting a server does not select it", () => {
    // Two actions on one row: the row picks, the link connects. A click on
    // Connect must not also commit a selection the user did not make.
    const onConnect = vi.fn();
    const onSelectServer = vi.fn();
    render(
      <ServerPickerPanel
        {...panelProps({
          servers: [
            { id: "down", name: "Down", status: DISCONNECTED, onConnect },
          ],
          onSelectServer,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/ }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onSelectServer).not.toHaveBeenCalled();
  });

  it("reports the picked server and marks the current one", () => {
    const onSelectServer = vi.fn();
    const { rerender } = render(
      <ServerPickerPanel {...panelProps({ onSelectServer })} />,
    );
    fireEvent.click(screen.getByText("Excalidraw (App)"));
    expect(onSelectServer).toHaveBeenCalledWith("srv_1");

    // Controlled: the mark follows the prop, the panel keeps no state.
    rerender(
      <ServerPickerPanel
        {...panelProps({ onSelectServer, selectedServerId: "srv_1" })}
      />,
    );
    expect(screen.getByRole("button", { name: /Excalidraw/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("renders no expandable control — the nesting is gone", () => {
    // BB-142's whole point: the old picker put an accordion inside the
    // popover. Asserted on the DOM, not through `queryByRole(…, {expanded})` —
    // that option only matches elements that already carry `aria-expanded`, so
    // both queries were null for any panel and adding a chevron kept them so.
    const { container } = render(<ServerPickerPanel {...panelProps()} />);
    expect(container.querySelector("[aria-expanded]")).toBeNull();
    expect(container.querySelector("[data-state='closed']")).toBeNull();
  });

  it("keeps Create new group off the Servers tab", () => {
    render(<ServerPickerPanel {...panelProps()} />);
    expect(screen.queryByText(/Create new group/)).toBeNull();
  });
});

describe("ServerPickerPanel — no synthetic 'none' row", () => {
  it("offers no Client default row on either tab", () => {
    // Not in the design: with nothing selected the client's own default already
    // applies, so a row for it would be a second way to say the same thing.
    render(<ServerPickerPanel {...panelProps()} />);
    expect(screen.queryByText(/Client default/i)).toBeNull();

    cleanup();
    render(<ServerPickerPanel {...panelProps({ tab: "groups" as const })} />);
    expect(screen.queryByText(/Client default/i)).toBeNull();
  });
});

describe("ServerPickerPanel — Server Groups tab", () => {
  const onGroups = (overrides: Record<string, unknown> = {}) =>
    panelProps({ tab: "groups" as const, ...overrides });

  it("lists groups with their servers as chips", () => {
    render(<ServerPickerPanel {...onGroups()} />);
    expect(screen.getByText("Group 1")).toBeInTheDocument();
    expect(screen.getAllByText("excalidraw")).toHaveLength(2);
  });

  it("collapses the overflow into +N past the chip limit", () => {
    render(
      <ServerPickerPanel
        {...onGroups({
          groups: [
            {
              id: "g_big",
              name: "Group 1",
              serverNames: ["a", "b", "c", "d", "e", "f"],
            },
          ],
          chipLimit: 2,
        })}
      />,
    );
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText("+4")).toBeInTheDocument();
    expect(screen.queryByText("c")).toBeNull();
  });

  it("shows every chip when the group fits the limit", () => {
    render(
      <ServerPickerPanel
        {...onGroups({
          groups: [{ id: "g", name: "G", serverNames: ["a", "b", "c"] }],
          chipLimit: 3,
        })}
      />,
    );
    expect(screen.queryByText(/^\+/)).toBeNull();
  });

  it("reports the picked group", () => {
    const onSelectGroup = vi.fn();
    render(<ServerPickerPanel {...onGroups({ onSelectGroup })} />);
    fireEvent.click(screen.getByText("Group 1"));
    expect(onSelectGroup).toHaveBeenCalledWith("g_1");
  });

  it("opens the create form here rather than submitting straight away", async () => {
    // `Create new group…` used to be the whole gesture. It now opens a form,
    // and only its Create button submits — see the creation suite below.
    const onCreateGroup = vi.fn();
    render(<ServerPickerPanel {...onGroups({ onCreateGroup })} />);
    await userEvent.click(screen.getByText("Create new group…"));

    expect(screen.getByLabelText("Group name")).toBeInTheDocument();
    expect(onCreateGroup).not.toHaveBeenCalled();
  });
});

describe("ServerPickerPanel — tabs", () => {
  it("exposes the tabs as a tablist with the active one selected", () => {
    render(<ServerPickerPanel {...panelProps()} />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Servers" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Server Groups" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("reports a tab change instead of switching itself", async () => {
    // `userEvent`, not `fireEvent.click`: Radix activates a tab on pointer-down
    // and focus, which a synthetic click does not produce. A real click does.
    const onTabChange = vi.fn();
    render(<ServerPickerPanel {...panelProps({ onTabChange })} />);
    await userEvent.click(screen.getByRole("tab", { name: "Server Groups" }));
    expect(onTabChange).toHaveBeenCalledWith("groups");
  });
});

describe("ServerPickerPanel — creating a group", () => {
  const onCreate = (overrides: Record<string, unknown> = {}) =>
    panelProps({
      tab: "groups" as const,
      deriveName: (picked: string[]) =>
        picked.length === 0
          ? "group 1"
          : picked.length === 1
            ? picked[0]
            : `${picked[0]} + ${picked.length - 1}`,
      ...overrides,
    });

  async function openForm() {
    await userEvent.click(screen.getByText("Create new group…"));
  }

  it("swaps the group list for a form", async () => {
    render(<ServerPickerPanel {...onCreate()} />);
    await openForm();
    expect(screen.getByLabelText("Group name")).toBeInTheDocument();
    expect(screen.queryByText("Group 1")).toBeNull();
  });

  it("suggests a name derived from the servers picked so far", async () => {
    render(<ServerPickerPanel {...onCreate()} />);
    await openForm();
    // Nothing picked yet — the caller's rule decides what that means.
    expect(screen.getByLabelText("Group name")).toHaveValue("group 1");

    await userEvent.click(screen.getByLabelText("Excalidraw (App)"));
    expect(screen.getByLabelText("Group name")).toHaveValue("Excalidraw (App)");

    await userEvent.click(screen.getByLabelText("Demo (App)"));
    expect(screen.getByLabelText("Group name")).toHaveValue(
      "Excalidraw (App) + 1",
    );
  });

  it("stops re-deriving once the user types their own name", async () => {
    render(<ServerPickerPanel {...onCreate()} />);
    await openForm();
    await userEvent.clear(screen.getByLabelText("Group name"));
    await userEvent.type(screen.getByLabelText("Group name"), "Prod");

    await userEvent.click(screen.getByLabelText("Excalidraw (App)"));
    expect(screen.getByLabelText("Group name")).toHaveValue("Prod");
  });

  it("refuses to submit without a server or without a name", async () => {
    render(<ServerPickerPanel {...onCreate()} />);
    await openForm();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

    await userEvent.click(screen.getByLabelText("Excalidraw (App)"));
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();

    await userEvent.clear(screen.getByLabelText("Group name"));
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("hands the caller the name and the picked ids", async () => {
    const onCreateGroup = vi.fn();
    render(<ServerPickerPanel {...onCreate({ onCreateGroup })} />);
    await openForm();
    await userEvent.click(screen.getByLabelText("Excalidraw (App)"));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreateGroup).toHaveBeenCalledWith("Excalidraw (App)", ["srv_1"]);
  });

  it("CANCEL discards the draft and never submits", async () => {
    // The picker this replaces committed a filled-in form on click-away,
    // because its Create button could fall below the fold. Cancel must
    // discard, and nothing but Create may submit.
    const onCreateGroup = vi.fn();
    render(<ServerPickerPanel {...onCreate({ onCreateGroup })} />);
    await openForm();
    await userEvent.click(screen.getByLabelText("Excalidraw (App)"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCreateGroup).not.toHaveBeenCalled();
    expect(screen.getByText("Group 1")).toBeInTheDocument();
  });

  it("KEEPS the draft when the caller rejects", async () => {
    // The submit is fire-and-forget today, so a duplicate-name rejection
    // leaves the user re-ticking every server they had picked.
    const onCreateGroup = vi.fn().mockRejectedValue(new Error("already exists"));
    render(<ServerPickerPanel {...onCreate({ onCreateGroup })} />);
    await openForm();
    await userEvent.click(screen.getByLabelText("Excalidraw (App)"));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.getByLabelText("Group name")).toBeInTheDocument();
    expect(screen.getByText("Servers (1 picked)")).toBeInTheDocument();
  });

  it("clears the form once the caller resolves", async () => {
    const onCreateGroup = vi.fn().mockResolvedValue(undefined);
    render(<ServerPickerPanel {...onCreate({ onCreateGroup })} />);
    await openForm();
    await userEvent.click(screen.getByLabelText("Excalidraw (App)"));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("Group 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("Group name")).toBeNull();
  });

  it("blocks a second submit while the first is in flight", async () => {
    // The disabled guard and the spinner were unreachable: the form used to
    // unmount in the same tick as the submit.
    let release!: () => void;
    const onCreateGroup = vi
      .fn()
      .mockImplementation(() => new Promise<void>((r) => (release = r)));
    render(<ServerPickerPanel {...onCreate({ onCreateGroup })} />);
    await openForm();
    await userEvent.click(screen.getByLabelText("Excalidraw (App)"));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.getByRole("button", { name: /Create/ })).toBeDisabled();
    release();
  });

  it("gives each panel its own field id", async () => {
    // Two pickers coexist — a Dialog over the composer. A fixed id makes the
    // dialog's label focus the input behind it.
    const { unmount } = render(<ServerPickerPanel {...onCreate()} />);
    await openForm();
    const first = screen.getByLabelText("Group name").getAttribute("id");
    unmount();

    render(<ServerPickerPanel {...onCreate()} />);
    await openForm();
    const second = screen.getByLabelText("Group name").getAttribute("id");

    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("reopens on an empty form, not the discarded draft", async () => {
    render(<ServerPickerPanel {...onCreate()} />);
    await openForm();
    await userEvent.click(screen.getByLabelText("Excalidraw (App)"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await openForm();

    expect(screen.getByLabelText("Group name")).toHaveValue("group 1");
  });
});

describe("ServerPickerPanel — removing a group", () => {
  it("offers no delete where the caller cannot perform one", () => {
    render(<ServerPickerPanel {...panelProps({ tab: "groups" })} />);
    expect(screen.queryByRole("button", { name: /^Delete Group 1$/ })).toBeNull();
  });

  it("reports the group to delete, and does not select it on the way", async () => {
    const onDeleteGroup = vi.fn();
    const onSelectGroup = vi.fn();
    render(
      <ServerPickerPanel
        {...panelProps({ tab: "groups", onDeleteGroup, onSelectGroup })}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Delete Group 1" }),
    );
    expect(onDeleteGroup).toHaveBeenCalledWith("g_1");
    // The delete sits inside the row; a click that also picked the group would
    // select the thing being removed.
    expect(onSelectGroup).not.toHaveBeenCalled();
  });

  it("withholds delete while a write is in flight", () => {
    render(
      <ServerPickerPanel
        {...panelProps({ tab: "groups", onDeleteGroup: vi.fn(), busy: true })}
      />,
    );
    expect(screen.getByRole("button", { name: "Delete Group 1" })).toBeDisabled();
  });
});

describe("ServerPickerPanel — a draft the catalog moved under", () => {
  it("submits only ids it still renders", async () => {
    // Nothing closes the form when `servers` changes, so a draft can outlive
    // the rows it was built from. Submitting a stale id writes a group whose
    // members the caller cannot resolve — and the name it derived, and the
    // "(N picked)" count, already disagree with it.
    const onCreateGroup = vi.fn();
    const deriveName = () => "Pair";
    const { rerender } = render(
      <ServerPickerPanel
        {...panelProps({ tab: "groups", onCreateGroup, deriveName })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Excalidraw (App)" }),
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Demo (App)" }));

    rerender(
      <ServerPickerPanel
        {...panelProps({
          tab: "groups",
          onCreateGroup,
          deriveName,
          servers: [{ id: "srv_1", name: "Excalidraw (App)", status: CONNECTED }],
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Create$/ }));

    expect(onCreateGroup).toHaveBeenCalledWith("Pair", ["srv_1"]);
  });
});

describe("ServerPickerPanel — busy", () => {
  // The caller refuses a second write while one is in flight. Without a signal
  // the panel keeps offering the controls, so the refusal reads as a dead
  // button rather than as "not yet".
  it("stops offering a server row it cannot act on", async () => {
    const onSelectServer = vi.fn();
    render(
      <ServerPickerPanel {...panelProps({ onSelectServer, busy: true })} />,
    );

    await userEvent.click(screen.getByTestId("server-status-dot-srv_1"));
    expect(onSelectServer).not.toHaveBeenCalled();
  });

  it("stops offering a group row it cannot act on", async () => {
    const onSelectGroup = vi.fn();
    render(
      <ServerPickerPanel
        {...panelProps({ tab: "groups", onSelectGroup, busy: true })}
      />,
    );

    const row = screen.getByText("Group 1").closest("button")!;
    await userEvent.click(row);
    expect(onSelectGroup).not.toHaveBeenCalled();
  });

  it("disables Create so the refusal is visible rather than silent", async () => {
    // The caller throws on a second write. Leaving Create enabled turns that
    // into a button that does nothing and says nothing.
    const deriveName = () => "New group";
    const { rerender } = render(
      <ServerPickerPanel {...panelProps({ tab: "groups", deriveName })} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /new group/i }));
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Excalidraw (App)" }),
    );
    expect(screen.getByRole("button", { name: /^Create$/ })).toBeEnabled();

    rerender(
      <ServerPickerPanel
        {...panelProps({ tab: "groups", deriveName, busy: true })}
      />,
    );
    expect(screen.getByRole("button", { name: /^Create$/ })).toBeDisabled();
  });
});

describe("ServerPickerPanel — an unanswered catalog", () => {
  it("says it is loading rather than claiming the project is empty", () => {
    // Carried over from the fix to the picker this replaces: `undefined` from
    // the catalog query means UNKNOWN, and unknown is not zero.
    render(
      <ServerPickerPanel
        {...panelProps({ servers: [], catalogKnown: false })}
      />,
    );
    expect(screen.queryByText("No servers in this project yet.")).toBeNull();
    expect(screen.getByText("Loading servers…")).toBeInTheDocument();
  });

  it("states the project is empty once the catalog has answered", () => {
    render(
      <ServerPickerPanel {...panelProps({ servers: [], catalogKnown: true })} />,
    );
    expect(
      screen.getByText("No servers in this project yet."),
    ).toBeInTheDocument();
  });
});
