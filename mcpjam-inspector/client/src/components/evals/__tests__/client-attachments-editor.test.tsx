import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getHostLogoSrc } from "@/lib/host-ui-metadata";
import { ClientAttachmentsEditor } from "../client-attachments-editor";

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [{ hostId: "host-a", name: "Codex QA", hostStyle: "codex" }],
    isLoading: false,
  }),
}));

vi.mock("@/components/hosts/HostPicker", () => ({
  HostPicker: () => null,
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
