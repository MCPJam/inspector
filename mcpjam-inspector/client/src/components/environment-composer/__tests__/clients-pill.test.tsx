import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { getHostLogoSrc } from "@/lib/host-ui-metadata";
import { ClientsPill } from "../clients-pill";

const navigateMock = vi.hoisted(() => vi.fn());
const webClients = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/hooks/useWebClientsEnabled", () => ({
  useWebClientsEnabled: () => webClients.enabled,
}));
const hostsMock = vi.hoisted(() => ({
  hosts: [
    {
      hostId: "host-a",
      name: "Claude",
      hostStyle: undefined as string | undefined,
      hostConfigId: "cfg-a",
      modelId: "gpt-4",
      serverCount: 0,
      createdAt: 0,
      updatedAt: 0,
    },
  ],
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/lib/app-navigation", () => ({
  navigateApp: navigateMock,
  routePaths: { hosts: "/hosts" },
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: hostsMock.hosts, isLoading: false }),
}));

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: ({
    isOpen,
    onCreated,
  }: {
    isOpen: boolean;
    onCreated?: (hostId: string) => void;
  }) =>
    isOpen ? (
      <button
        type="button"
        data-testid="create-host-dialog"
        onClick={() => onCreated?.("host-new")}
      />
    ) : null,
}));

describe("ClientsPill web clients", () => {
  it("lists a project's ChatGPT web client only while the flag is on", async () => {
    const before = hostsMock.hosts;
    hostsMock.hosts = [
      ...before,
      {
        ...before[0]!,
        hostId: "host-web",
        name: "ChatGPT web",
        runtime: "chatgpt-web",
      } as (typeof before)[number],
    ];
    try {
      for (const enabled of [false, true]) {
        webClients.enabled = enabled;
        const user = userEvent.setup();
        const { unmount } = render(
          <ClientsPill
            projectId="proj-1"
            value={[]}
            onChange={vi.fn()}
            max={4}
            testId="clients"
          />,
        );
        await user.click(screen.getByTestId("clients"));
        expect(
          screen.queryByText("ChatGPT web") !== null,
          `flag ${enabled}`,
        ).toBe(enabled);
        unmount();
      }
    } finally {
      hostsMock.hosts = before;
      webClients.enabled = false;
    }
  });

  it("keeps a web client the suite already uses, by name, so it can be unticked with the flag off", async () => {
    const before = hostsMock.hosts;
    hostsMock.hosts = [
      ...before,
      {
        ...before[0]!,
        hostId: "host-web",
        name: "ChatGPT web",
        runtime: "chatgpt-web",
      } as (typeof before)[number],
    ];
    webClients.enabled = false;
    try {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(
        <ClientsPill
          projectId="proj-1"
          value={["host-web"]}
          onChange={onChange}
          max={4}
          testId="clients"
        />,
      );
      expect(screen.getByTestId("clients")).toHaveTextContent("ChatGPT web");
      await user.click(screen.getByTestId("clients"));
      const row = screen.getByRole("checkbox", { name: "ChatGPT web" });
      expect(row).toBeChecked();
      await user.click(row);
      expect(onChange).toHaveBeenCalledWith([]);
    } finally {
      hostsMock.hosts = before;
    }
  });
});

describe("ClientsPill create", () => {
  it("opens the New Client modal from Add clients instead of leaving to the clients page", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ClientsPill
        projectId="proj-1"
        value={["host-a"]}
        onChange={onChange}
        max={4}
        testId="clients"
      />,
    );

    await user.click(screen.getByTestId("clients"));
    expect(screen.queryByText("Manage clients…")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add clients" }));
    expect(screen.getByTestId("create-host-dialog")).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("create-host-dialog"));
    expect(onChange).toHaveBeenCalledWith(["host-a", "host-new"]);
  });

  it("does not select a created client when the budget is full", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ClientsPill
        projectId="proj-1"
        value={["host-a"]}
        onChange={onChange}
        max={4}
        budget={{ choiceCount: 3, maxTargets: 3 }}
        testId="clients"
      />,
    );

    await user.click(screen.getByTestId("clients"));
    await user.click(screen.getByTestId("clients-pill-add"));
    await user.click(screen.getByTestId("create-host-dialog"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ClientsPill logos", () => {
  it("draws a renamed client's logo from its saved style", async () => {
    const user = userEvent.setup();
    const original = hostsMock.hosts;
    hostsMock.hosts = [
      { ...original[0], name: "Codex QA", hostStyle: "codex" },
    ];
    try {
      render(
        <ClientsPill
          projectId="proj-1"
          value={["host-a"]}
          onChange={() => {}}
          max={4}
          testId="clients"
        />,
      );

      const codex = getHostLogoSrc("codex");
      expect(
        screen.getByTestId("clients").querySelector("img"),
      ).toHaveAttribute("src", codex);
      await user.click(screen.getByTestId("clients"));
      const option = screen.getByRole("checkbox", { name: /Codex QA/ });
      expect(
        option.closest("label, div")?.querySelector("img"),
      ).toHaveAttribute("src", codex);
    } finally {
      hostsMock.hosts = original;
    }
  });
});
