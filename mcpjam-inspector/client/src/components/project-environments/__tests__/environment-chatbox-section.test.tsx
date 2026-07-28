/**
 * The publish-as-chatbox panel on the Environments route (Phase 5,
 * live-follow). Mutations are mocked with a NAME-KEYED dispatcher (the
 * ChatboxesTab.journeys pattern) — a single-mutation mock breaks the moment a
 * component holds more than one `useMutation`.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockQuery, mutationMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mutationMocks: {
    publish: vi.fn(),
    unpublish: vi.fn(),
    setMode: vi.fn(),
  },
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => mockQuery(name, args),
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: (name: string) => {
    switch (name) {
      case "chatboxes:publishEnvironmentChatbox":
        return mutationMocks.publish;
      case "chatboxes:unpublishEnvironmentChatbox":
        return mutationMocks.unpublish;
      case "chatboxes:setChatboxMode":
        return mutationMocks.setMode;
      default:
        return vi.fn();
    }
  },
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("@/hooks/useProjects", () => ({
  shouldQueryProjectId: (projectId: string | null | undefined) => !!projectId,
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { EnvironmentChatboxSection } from "../environment-chatbox-section";

const ENV_CHATBOX_ROW = {
  chatboxId: "cbx-env",
  environmentId: "env-1",
  name: "Staging",
  mode: "anyone_with_link",
  allowGuestAccess: true,
  link: {
    token: "tok",
    path: "/c/tok",
    url: "https://mcpjam.com/c/tok",
  },
};

function stubChatboxList(rows: unknown[] | undefined) {
  mockQuery.mockImplementation((name: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (name === "chatboxes:listChatboxes") return rows;
    return undefined;
  });
}

function renderSection(props?: Partial<{ canManage: boolean }>) {
  return render(
    <EnvironmentChatboxSection
      projectId="proj-1"
      environmentId="env-1"
      environmentName="Staging"
      canManage={props?.canManage ?? true}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mutationMocks.publish.mockResolvedValue({
    chatboxId: "cbx-env",
    environmentId: "env-1",
    created: true,
  });
  mutationMocks.unpublish.mockResolvedValue({ deleted: true });
  mutationMocks.setMode.mockResolvedValue({});
});

describe("EnvironmentChatboxSection", () => {
  it("offers publish when the environment has no chatbox", async () => {
    stubChatboxList([]);
    renderSection();

    fireEvent.click(screen.getByTestId("environment-chatbox-publish"));
    await waitFor(() =>
      expect(mutationMocks.publish).toHaveBeenCalledWith({
        environmentId: "env-1",
      })
    );
  });

  it("renders nothing while the list is loading (no publish flash)", () => {
    stubChatboxList(undefined);
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the share link and unpublishes behind a confirm", async () => {
    stubChatboxList([ENV_CHATBOX_ROW]);
    renderSection();

    expect(
      screen.getByTestId("environment-chatbox-link").textContent
    ).toContain("https://mcpjam.com/c/tok");

    // First click arms the confirm; the mutation must NOT fire yet.
    fireEvent.click(screen.getByTestId("environment-chatbox-unpublish"));
    expect(mutationMocks.unpublish).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByTestId("environment-chatbox-unpublish-confirm")
    );
    await waitFor(() =>
      expect(mutationMocks.unpublish).toHaveBeenCalledWith({
        environmentId: "env-1",
      })
    );
  });

  it("ignores another environment's chatbox row", () => {
    stubChatboxList([{ ...ENV_CHATBOX_ROW, environmentId: "env-other" }]);
    renderSection();
    // Reads as unpublished → publish affordance, no link.
    expect(
      screen.getByTestId("environment-chatbox-publish")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("environment-chatbox-link")
    ).not.toBeInTheDocument();
  });

  it("read-only members see the link but no publish/unpublish/access controls", () => {
    stubChatboxList([ENV_CHATBOX_ROW]);
    renderSection({ canManage: false });

    expect(screen.getByTestId("environment-chatbox-link")).toBeInTheDocument();
    expect(
      screen.queryByTestId("environment-chatbox-unpublish")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("environment-chatbox-access")
    ).not.toBeInTheDocument();
  });

  it("read-only members with an UNPUBLISHED environment see nothing", () => {
    stubChatboxList([]);
    const { container } = renderSection({ canManage: false });
    expect(container).toBeEmptyDOMElement();
  });
});
