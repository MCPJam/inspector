import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RealClientNotice } from "../RealClientNotice";
import { RunPausedForPerson } from "../RunPausedForPerson";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/app-navigation", () => ({ navigateApp: navigate }));

afterEach(cleanup);

const buttons = () =>
  screen.queryAllByRole("button").map((button) => button.textContent);

describe("RealClientNotice", () => {
  it("tells an admin the run stopped on a signed-out account, and to sign in again", async () => {
    const onSignInAgain = vi.fn();
    render(
      <RealClientNotice
        vendor="claude"
        isAdmin
        stop={{ kind: "needs_sign_in", account: "qa@example.com" }}
        onSignInAgain={onSignInAgain}
        onSendAgain={vi.fn()}
        onCopyAdminLink={vi.fn()}
      />,
    );
    const notice = screen.getByTestId("real-client-notice");
    expect(notice).toHaveTextContent("claude.ai signed out qa@example.com");
    expect(notice).toHaveTextContent("your server wasn't graded");
    expect(buttons()).toEqual(["Sign in again", "Send again"]);
    await userEvent.click(
      screen.getByRole("button", { name: "Sign in again" }),
    );
    expect(onSignInAgain).toHaveBeenCalledOnce();
  });

  it("gives a member a link for an admin instead of signing in", () => {
    render(
      <RealClientNotice
        vendor="chatgpt"
        stop={{ kind: "needs_sign_in", account: "qa@example.com" }}
        onSignInAgain={vi.fn()}
        onSendAgain={vi.fn()}
        onCopyAdminLink={vi.fn()}
      />,
    );
    expect(screen.getByTestId("real-client-notice")).toHaveTextContent(
      "chatgpt.com signed out qa@example.com",
    );
    expect(buttons()).toEqual(["Copy link for an admin"]);
  });

  it("quotes the site's limit message and offers Send again", () => {
    render(
      <RealClientNotice
        vendor="claude"
        stop={{ kind: "plan_limit", siteMessage: "Usage limit reached." }}
        onSendAgain={vi.fn()}
      />,
    );
    const notice = screen.getByTestId("real-client-notice");
    expect(notice).toHaveTextContent("claude.ai said “Usage limit reached.”");
    expect(notice).toHaveTextContent("your server wasn't graded");
    expect(buttons()).toEqual(["Send again"]);
  });

  it("names MCPJam, the step and the build when MCPJam can't drive the page", () => {
    render(
      <RealClientNotice
        vendor="claude"
        stop={{
          kind: "page_module",
          step: "Send message",
          build: "2026.11.18",
        }}
        onRetry={vi.fn()}
        onOpenTrace={vi.fn()}
      />,
    );
    const notice = screen.getByTestId("real-client-notice");
    expect(notice).toHaveTextContent(
      "MCPJam couldn't finish the step “Send message” on Claude web",
    );
    expect(notice).toHaveTextContent(
      "This happened on claude.ai build 2026.11.18.",
    );
    expect(buttons()).toEqual(["Retry", "Open trace"]);
  });

  it("leaves out an action with no handler", () => {
    render(
      <RealClientNotice
        vendor="claude"
        stop={{ kind: "page_module", step: "Send message" }}
        onRetry={vi.fn()}
      />,
    );
    expect(buttons()).toEqual(["Retry"]);
  });
});

describe("RunPausedForPerson", () => {
  it("says what the page asked and who can finish a human check, in the warning color", async () => {
    const onCopyLink = vi.fn();
    const onStop = vi.fn();
    render(
      <RunPausedForPerson
        vendor="claude"
        ask="human_check"
        canFinish
        takeOverPath="/web-accounts/wa-1/reconnect?request=req-1&project=project-1"
        onCopyLink={onCopyLink}
        onStop={onStop}
      />,
    );
    const panel = screen.getByRole("region", { name: "Paused for a person" });
    expect(panel.className).toContain("bg-warning/10");
    expect(
      within(panel).getByText(/“Verify you are human” check/),
    ).toBeTruthy();
    expect(panel).toHaveTextContent(
      "Anyone in this project with the chat's link.",
    );
    expect(buttons()).toEqual([
      "Take over",
      "Copy link for a teammate",
      "Stop run",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Take over" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Copy link for a teammate" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Stop run" }));
    expect(navigate).toHaveBeenCalledWith(
      "/web-accounts/wa-1/reconnect?request=req-1&project=project-1",
    );
    expect(onCopyLink).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("leaves a sign-in to an admin when the viewer is a member", () => {
    render(
      <RunPausedForPerson
        vendor="chatgpt"
        ask="sign_in"
        canFinish={false}
        takeOverPath="/web-accounts/wa-1/reconnect?project=project-1"
        onCopyLink={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    const panel = screen.getByRole("region", { name: "Paused for a person" });
    expect(panel).toHaveTextContent("chatgpt.com signed the account out");
    expect(panel).toHaveTextContent("A project admin, by signing in again");
    expect(buttons()).toEqual(["Copy link for an admin", "Stop run"]);
  });
});
