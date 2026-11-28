import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mint = vi.fn(async () => ({ token: "t", expiresAt: 0 }));

vi.mock("@/hooks/useProjectComputer", () => ({
  useMintConversationBrowserToken: () => mint,
}));
// The hosted body has its own suite; here it shows what it was handed.
vi.mock("@/components/browser/HostedBrowserBody", () => ({
  HostedBrowserBody: (props: {
    sessionId?: string;
    allowProfileSave?: boolean;
    mintToken: (args: { projectId: string }) => Promise<unknown>;
  }) => (
    <button
      type="button"
      data-testid="hosted-body"
      data-session={props.sessionId}
      data-profile-save={String(props.allowProfileSave)}
      onClick={() => void props.mintToken({ projectId: "project-1" })}
    />
  ),
}));

const { WebSignInBrowser } = await import("../WebSignInBrowser");

describe("WebSignInBrowser", () => {
  it("attaches by the browser's chat, which its token names", async () => {
    render(<WebSignInBrowser projectId="project-1" chatSessionId="chat-1" />);
    const body = screen.getByTestId("hosted-body");
    expect(body).toHaveAttribute("data-session", "chat-1");
    body.click();
    expect(mint).toHaveBeenCalledWith({
      projectId: "project-1",
      conversationId: "chat-1",
    });
  });

  it("never offers to save the account's browser as a personal profile", () => {
    render(<WebSignInBrowser projectId="project-1" chatSessionId="chat-1" />);
    expect(screen.getByTestId("hosted-body")).toHaveAttribute(
      "data-profile-save",
      "false",
    );
  });
});
