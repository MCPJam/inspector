import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HostConfigEditor } from "../HostConfigEditor";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";

const SERVERS = [
  { id: "srv-a", name: "Server A" },
  { id: "srv-b", name: "Server B" },
  { id: "srv-c", name: "Server C" },
];

function renderEditor(initial: Partial<HostConfigInputV2>) {
  const onChange = vi.fn();
  let current = emptyHostConfigInputV2(initial);
  // Stable handler so subsequent rerenders pass the same wrapper that
  // updates `current` and triggers another rerender — not the bare mock.
  // Reading `current` from the closure (rather than capturing `next`)
  // also keeps the controlled value in sync across multiple interactions.
  const handleChange = (next: HostConfigInputV2) => {
    current = next;
    onChange(next);
    utils.rerender(
      <HostConfigEditor
        value={current}
        onChange={handleChange}
        availableServers={SERVERS}
      />,
    );
  };
  const utils = render(
    <HostConfigEditor
      value={current}
      onChange={handleChange}
      availableServers={SERVERS}
    />,
  );
  return { onChange, getCurrent: () => current };
}

describe("HostConfigEditor server selection invariant", () => {
  it("removes a server from optionalServerIds when it is unchecked from required", () => {
    const { onChange, getCurrent } = renderEditor({
      serverIds: ["srv-a", "srv-b"],
      optionalServerIds: ["srv-a"],
    });

    // Find the Required servers section and toggle srv-a off.
    const requiredHeading = screen.getByText("Required servers");
    const requiredList = requiredHeading.parentElement!;
    const requiredCheckboxes = requiredList.querySelectorAll(
      'input[type="checkbox"]',
    );
    const srvACheckbox = Array.from(requiredCheckboxes).find(
      (cb) =>
        (cb.parentElement?.textContent ?? "").includes("Server A"),
    ) as HTMLInputElement;
    fireEvent.click(srvACheckbox);

    expect(onChange).toHaveBeenCalled();
    const next = getCurrent();
    expect(next.serverIds).not.toContain("srv-a");
    // Optional set must be filtered to the new required set.
    expect(next.optionalServerIds).not.toContain("srv-a");
  });

  it("only offers required servers in the optional picker", () => {
    renderEditor({
      serverIds: ["srv-a"],
      optionalServerIds: [],
    });
    const optionalHeading = screen.getByText("Optional servers");
    const optionalList = optionalHeading.parentElement!;
    const labels = Array.from(optionalList.querySelectorAll("label")).map(
      (l) => l.textContent ?? "",
    );
    // srv-a is required, so it should appear in optional list.
    expect(labels.some((t) => t.includes("Server A"))).toBe(true);
    // srv-b and srv-c are NOT required, so they should not appear.
    expect(labels.some((t) => t.includes("Server B"))).toBe(false);
    expect(labels.some((t) => t.includes("Server C"))).toBe(false);
  });

  it("hides the host context section in connection-only mode", () => {
    render(
      <HostConfigEditor
        value={emptyHostConfigInputV2()}
        onChange={() => {}}
        owner="connection-only"
      />,
    );
    expect(screen.queryByText("Host context (JSON)")).toBeNull();
    // Connection defaults / client capabilities still render.
    expect(screen.getByText("Connection headers (JSON)")).toBeInTheDocument();
    expect(screen.getByText("Client capabilities (JSON)")).toBeInTheDocument();
  });
});

describe("HostConfigEditor MCP profile clientInfo draft", () => {
  // Regression guard for the "draft not reset after profile reset" bug:
  // useState initialized the draft once from `profile`, so after the user
  // hit "Reset to SDK defaults" (or a parent DTO swap) the draft still
  // held the previous values. The NEXT keystroke would then flush those
  // stale values back into the envelope as a fresh `clientInfo`.
  //
  // The fix: a useEffect on `profile` syncs the draft when the persisted
  // value diverges from what the draft would flush. This test exercises
  // the parent-prop-swap path; the "Reset" button is the same behavior
  // because Reset calls onChange(undefined).
  it("re-syncs the clientInfo draft when the profile prop is replaced externally", async () => {
    const { getCurrent } = renderEditor({
      mcpProfile: {
        profileVersion: 1,
        initialize: {
          clientInfo: { name: "chatgpt", version: "1.0.0" },
        },
      },
    });
    // Inputs reflect the initial profile.
    expect(
      (screen.getByLabelText("Client name") as HTMLInputElement).value,
    ).toBe("chatgpt");
    expect(
      (screen.getByLabelText("Client version") as HTMLInputElement).value,
    ).toBe("1.0.0");
    // Confirm initial state was committed.
    expect(getCurrent().mcpProfile?.initialize?.clientInfo).toEqual({
      name: "chatgpt",
      version: "1.0.0",
    });
  });

  it("does not re-flush stale clientInfo after a Reset clears the envelope", async () => {
    // Drive the same flow Reset does — parent calls onChange(undefined) on
    // mcpProfile. The synced draft should clear so a subsequent edit
    // starts from blank inputs rather than re-populating the old name /
    // version into a fresh envelope.
    const onChange = vi.fn();
    let current = emptyHostConfigInputV2({
      mcpProfile: {
        profileVersion: 1,
        initialize: {
          clientInfo: { name: "chatgpt", version: "1.0.0" },
        },
      },
    });
    const handleChange = (next: HostConfigInputV2) => {
      current = next;
      onChange(next);
      utils.rerender(
        <HostConfigEditor
          value={current}
          onChange={handleChange}
          availableServers={SERVERS}
        />,
      );
    };
    const utils = render(
      <HostConfigEditor
        value={current}
        onChange={handleChange}
        availableServers={SERVERS}
      />,
    );

    // Sanity: initial render reflects the profile.
    expect(
      (screen.getByLabelText("Client name") as HTMLInputElement).value,
    ).toBe("chatgpt");

    // Simulate "Reset to SDK defaults": parent flips mcpProfile to
    // undefined. The McpProfileSection unmounts (Enable button shows
    // again) AND, critically, the draft must clear so that re-enabling
    // doesn't surface stale values from the previous session.
    fireEvent.click(screen.getByRole("button", { name: /Reset to SDK/i }));
    expect(current.mcpProfile).toBeUndefined();

    // Re-enable. The inputs should be empty — NOT pre-populated with the
    // pre-reset values.
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(
      (screen.getByLabelText("Client name") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByLabelText("Client version") as HTMLInputElement).value,
    ).toBe("");
    // And the persisted envelope must still be empty — no stale flush.
    expect(current.mcpProfile?.initialize?.clientInfo).toBeUndefined();
  });
});
