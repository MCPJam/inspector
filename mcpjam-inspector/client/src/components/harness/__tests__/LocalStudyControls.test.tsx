import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { LocalStudyControls } from "../LocalStudyControls";
import type { LocalStudyController } from "@/hooks/use-local-study-target";
const setup = vi.fn(async () => {});
const cloud = vi.fn();
const controller = (
  extra: Partial<LocalStudyController> = {},
): LocalStudyController => ({
  key: "actor-study",
  requested: false,
  loading: false,
  error: null,
  setup,
  useCloud: cloud,
  clearGrant: vi.fn(),
  isBoundConversation: () => false,
  resolveSendTarget: () => null,
  ...extra,
});
beforeEach(() => {
  vi.clearAllMocks();
});
it("asks permission and performs setup only after explicit confirmation", async () => {
  render(
    <LocalStudyControls
      controller={controller()}
      chatSessionId="chat"
      disabled={false}
    />,
  );
  expect(screen.getByText("Cloud")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Run on this machine" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("OS user");
  expect(screen.getByRole("dialog")).toHaveTextContent("without asking again");
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "saved model source and billing",
  );
  expect(screen.getByRole("dialog")).toHaveTextContent("press Send");
  expect(screen.getByRole("dialog")).toHaveTextContent("Revoke local access");
  expect(setup).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Authorize this conversation" }),
  );
  await waitFor(() => expect(setup).toHaveBeenCalledWith("chat"));
});
it("cancel keeps the existing venue and never authorizes", () => {
  render(
    <LocalStudyControls
      controller={controller()}
      chatSessionId="chat"
      disabled={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Run on this machine" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(setup).not.toHaveBeenCalled();
  expect(screen.getByText("Cloud")).toBeInTheDocument();
});
it("shows unavailable and actionable failure without implying a cloud fallback", () => {
  render(
    <LocalStudyControls
      controller={controller({
        requested: true,
        error: "Choose and save a model source",
      })}
      chatSessionId="chat"
      disabled={false}
    />,
  );
  expect(screen.getByText("Unavailable")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Choose and save");
  fireEvent.click(screen.getByRole("button", { name: "Use cloud" }));
  expect(cloud).toHaveBeenCalledOnce();
});
it("prevents switching venues during an active turn", () => {
  render(
    <LocalStudyControls
      controller={controller({ requested: true })}
      chatSessionId="chat"
      disabled
    />,
  );
  expect(screen.getByRole("button", { name: "Local setup" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Use cloud" })).toBeDisabled();
});

const localReady = {
  state: "ready" as const,
  token: "token",
  expiresAt: "2999-01-01T00:00:00Z",
  workspaceDisplayRoot: "~/study",
  target: {
    kind: "local-native" as const,
    harnessId: "codex" as const,
    machineId: "machine",
    workspaceGrantId: "workspace",
    runtimeId: "runtime",
    permissionProfile: "workspace-edits",
    policyVersion: "policy",
    localStudySessionId: "reservation",
  },
};
const revoke = vi.fn(async () => {});
const revocation = {
  key: "scope",
  pending: false,
  revoked: false,
  cleanupComplete: false,
  error: null,
  revoke,
};
it("can revoke an active or expired local study grant", () => {
  render(
    <LocalStudyControls
      controller={controller({
        requested: true,
        chatSessionId: "chat",
        ready: localReady,
      })}
      revocation={revocation}
      chatSessionId="chat"
      disabled
    />,
  );
  const button = screen.getByRole("button", { name: "Revoke local access" });
  expect(button).not.toBeDisabled();
  fireEvent.click(button);
  expect(revoke).toHaveBeenCalledWith("reservation");
});
it("reports incomplete stopping and offers cleanup retry", () => {
  render(
    <LocalStudyControls
      controller={controller()}
      revocation={{
        ...revocation,
        reservationId: "reservation",
        revoked: true,
      }}
      chatSessionId="chat"
      disabled={false}
    />,
  );
  expect(screen.getByText(/has not confirmed stopping/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
  expect(revoke).toHaveBeenCalledWith(undefined);
  expect(
    screen.getByRole("button", { name: "Run on this machine" }),
  ).toBeDisabled();
});
it("never offers another conversation's grant for revocation", () => {
  render(
    <LocalStudyControls
      controller={controller({ chatSessionId: "other", ready: localReady })}
      revocation={revocation}
      chatSessionId="chat"
      disabled={false}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Revoke local access" }),
  ).not.toBeInTheDocument();
});

it("shows cloud without offering local execution to an ineligible study actor", () => {
  render(
    <LocalStudyControls
      controller={controller()}
      chatSessionId="chat"
      disabled={false}
      allowSetup={false}
    />,
  );
  expect(screen.getByText("Cloud")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Run on this machine" }),
  ).not.toBeInTheDocument();
});

it("requires a new conversation for cloud after local setup and retains revoke", () => {
  render(
    <LocalStudyControls
      controller={controller({
        requested: true,
        chatSessionId: "chat",
        ready: localReady,
        isBoundConversation: () => true,
      })}
      revocation={revocation}
      chatSessionId="chat"
      disabled={false}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Use cloud" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("Start a new conversation to use cloud."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Revoke local access" }),
  ).toBeEnabled();
});
