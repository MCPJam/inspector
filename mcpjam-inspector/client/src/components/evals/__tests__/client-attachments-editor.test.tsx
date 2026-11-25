import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getHostLogoSrc } from "@/lib/host-ui-metadata";
import { ClientAttachmentsEditor } from "../client-attachments-editor";

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

const hostsMock = vi.hoisted(() => ({
  hosts: [{ hostId: "host-a", name: "Codex QA", hostStyle: "codex" }] as {
    hostId: string;
    name: string;
    hostStyle?: string;
    runtime?: string;
  }[],
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: hostsMock.hosts, isLoading: false }),
}));

const webClients = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/hooks/useWebClientsEnabled", () => ({
  useWebClientsEnabled: () => webClients.enabled,
}));

vi.mock("@/components/hosts/HostPicker", () => ({
  HostPicker: ({
    placeholder,
    disabled,
  }: {
    placeholder?: string;
    disabled?: boolean;
  }) => (
    <button type="button" data-testid="host-picker" disabled={disabled}>
      {placeholder}
    </button>
  ),
}));

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: () => null,
}));

describe("ClientAttachmentsEditor", () => {
  it("draws a renamed client's logo from its saved style", () => {
    render(
      <ClientAttachmentsEditor
        projectId="proj-1"
        value={[{ namedHostId: "host-a", enabledOptionalServerIds: [] }]}
        onChange={() => {}}
      />,
    );

    const row = screen.getByText("Codex QA").parentElement;
    expect(row?.querySelector("img")).toHaveAttribute(
      "src",
      getHostLogoSrc("codex"),
    );
  });
});

describe("ClientAttachmentsEditor web clients", () => {
  it("reads as full once every client the picker offers is attached, flag off", () => {
    const before = hostsMock.hosts;
    hostsMock.hosts = [
      ...before,
      { hostId: "host-web", name: "ChatGPT web", runtime: "chatgpt-web" },
    ];
    try {
      for (const [enabled, full] of [
        [false, true],
        [true, false],
      ] as const) {
        webClients.enabled = enabled;
        const { unmount } = render(
          <ClientAttachmentsEditor
            projectId="proj-1"
            value={[{ namedHostId: "host-a", enabledOptionalServerIds: [] }]}
            onChange={() => {}}
          />,
        );
        const picker = screen.getByTestId("host-picker");
        expect(picker, `flag ${enabled}`).toHaveTextContent(
          full ? "All clients attached" : "Choose a client to attach",
        );
        expect(picker.hasAttribute("disabled"), `flag ${enabled}`).toBe(full);
        unmount();
      }
    } finally {
      hostsMock.hosts = before;
      webClients.enabled = false;
    }
  });
});
