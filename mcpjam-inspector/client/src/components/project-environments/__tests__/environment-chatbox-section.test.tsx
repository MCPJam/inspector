/**
 * Publish-as-chatbox section (env detail): publish round-trip, link actions
 * on the published row, admin gating, and error copy passthrough.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { publishMock, unpublishMock, toastMock, copyMock } = vi.hoisted(() => ({
  publishMock: vi.fn(),
  unpublishMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
  copyMock: vi.fn(),
}));

/** Mutable per-test chatbox list returned by `chatboxes:listChatboxes`. */
let chatboxList: Array<Record<string, unknown>> | undefined = [];

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (name === "chatboxes:listChatboxes") return chatboxList;
    return undefined;
  },
  useMutation: (name: string) => {
    if (name === "chatboxes:publishEnvironmentChatbox") return publishMock;
    if (name === "chatboxes:unpublishEnvironmentChatbox") return unpublishMock;
    return vi.fn();
  },
}));

vi.mock("@/hooks/useProjects", () => ({
  shouldQueryProjectId: () => true,
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (...args: unknown[]) => copyMock(...args),
}));
vi.mock("@/lib/chatbox-session", () => ({
  buildChatboxLink: (token: string) => `https://app.test/chat/${token}`,
}));

import { EnvironmentChatboxSection } from "../environment-chatbox-section";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

const environment: ProjectEnvironmentView = {
  environmentId: "env-1",
  projectId: "proj-1",
  name: "Prod-like",
  hostId: "host-1",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

const publishedChatbox = {
  chatboxId: "cb-1",
  projectId: "proj-1",
  name: "Prod-like",
  environmentId: "env-1",
  link: { token: "tok-1", path: "/chat/tok-1", url: "https://x/chat/tok-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  chatboxList = [];
  publishMock.mockResolvedValue({
    chatboxId: "cb-1",
    environmentId: "env-1",
    name: "Prod-like",
    mode: "project_members",
    accessVersion: 1,
    link: publishedChatbox.link,
    created: true,
  });
  unpublishMock.mockResolvedValue({ deleted: true, chatboxId: "cb-1" });
  copyMock.mockResolvedValue(true);
});

function renderSection(canManage = true) {
  return render(
    <EnvironmentChatboxSection
      projectId="proj-1"
      environment={environment}
      canManage={canManage}
    />
  );
}

describe("EnvironmentChatboxSection", () => {
  it("publishes the environment as a chatbox", async () => {
    renderSection();
    fireEvent.click(screen.getByTestId("environment-chatbox-publish"));
    await waitFor(() => {
      expect(publishMock).toHaveBeenCalledWith({ environmentId: "env-1" });
    });
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("read-only members see state, not the publish action", () => {
    renderSection(false);
    expect(
      screen.queryByTestId("environment-chatbox-publish")
    ).not.toBeInTheDocument();
    expect(screen.getByText(/not published/i)).toBeInTheDocument();
  });

  it("published: copies the share link built from the row's token", async () => {
    chatboxList = [publishedChatbox];
    renderSection();
    fireEvent.click(screen.getByTestId("environment-chatbox-copy-link"));
    await waitFor(() => {
      expect(copyMock).toHaveBeenCalledWith("https://app.test/chat/tok-1");
    });
  });

  it("unpublish requires an explicit confirm and calls the mutation", async () => {
    chatboxList = [publishedChatbox];
    renderSection();
    fireEvent.click(screen.getByTestId("environment-chatbox-unpublish"));
    expect(unpublishMock).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByTestId("environment-chatbox-unpublish-confirm")
    );
    await waitFor(() => {
      expect(unpublishMock).toHaveBeenCalledWith({ environmentId: "env-1" });
    });
  });

  it("surfaces backend FORBIDDEN copy verbatim on publish", async () => {
    publishMock.mockRejectedValue({
      data: {
        code: "FORBIDDEN",
        message:
          "Publishing an environment chatbox requires project admin (shared execution config).",
      },
    });
    renderSection();
    fireEvent.click(screen.getByTestId("environment-chatbox-publish"));
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringContaining("requires project admin")
      );
    });
  });

  it("a chatbox for a DIFFERENT environment does not read as published", () => {
    chatboxList = [{ ...publishedChatbox, environmentId: "env-other" }];
    renderSection();
    expect(
      screen.getByTestId("environment-chatbox-publish")
    ).toBeInTheDocument();
  });
});
