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
  const utils = render(
    <HostConfigEditor
      value={current}
      onChange={(next) => {
        current = next;
        onChange(next);
        utils.rerender(
          <HostConfigEditor
            value={next}
            onChange={onChange}
            availableServers={SERVERS}
          />,
        );
      }}
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
