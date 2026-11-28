import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  HostedMrtrHost,
  __resetHostedMrtrHostElection,
} from "../HostedMrtrHost";
import {
  useHostedMrtrStore,
  type HostedMrtrRound,
} from "@/stores/hosted-mrtr-store";
import {
  registerComposerSlot,
  __resetComposerFormStore,
} from "../composer-form-store";

const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track }));

const pluginRound = (
  overrides: Partial<HostedMrtrRound> = {},
): HostedMrtrRound => ({
  key: "cont-1:0",
  continuationId: "cont-1",
  round: 0,
  serverId: "srv-1",
  serverName: "PRIVATE_SERVER",
  method: "tools/call",
  operationLabel: "create_issue",
  requests: [
    {
      key: "k1",
      mode: "form",
      message: "HOSTED_MRTR_PROMPT",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    },
  ],
  expiresAt: Date.now() + 300_000,
  timestamp: new Date().toISOString(),
  pluginFormServiceScope: { projectId: "project", workspaceId: "workspace" },
  pluginFormProfile: {
    origin: "server",
    fileResources: false,
    userResources: false,
    previews: false,
  },
  ...overrides,
});
const outcomes = () =>
  track.mock.calls
    .filter((call) => call[0] === "extension_operation_completed")
    .map((call) => call[1]);
function enqueue(value: HostedMrtrRound, submit: () => Promise<void>) {
  act(() => {
    useHostedMrtrStore.getState().enqueue(value, { submit: submit as never });
  });
}

beforeEach(() => {
  track.mockClear();
  __resetHostedMrtrHostElection();
  useHostedMrtrStore.getState().__reset();
});
afterEach(() => {
  cleanup();
  __resetComposerFormStore();
  __resetHostedMrtrHostElection();
  useHostedMrtrStore.getState().__reset();
});

describe("MRTR plugin form round outcome", () => {
  it("records one success when the composer card's round is submitted", async () => {
    const slot = document.createElement("div");
    document.body.append(slot);
    let release!: () => void;
    act(() => {
      release = registerComposerSlot("workspace", slot);
    });
    render(<HostedMrtrHost />);
    enqueue(pluginRound(), async () => {});
    await userEvent.type(await screen.findByRole("textbox"), "PRIVATE_VALUE");
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()).toEqual([
      {
        operation: "form_response",
        host_profile: "unknown",
        outcome: "success",
        error_code: "none",
        location: "host_workspace",
      },
    ]);
    expect(JSON.stringify(track.mock.calls)).not.toContain("PRIVATE");
    act(release);
    slot.remove();
  });

  it("records one failure when the dialog round's submit is refused", async () => {
    render(<HostedMrtrHost />);
    enqueue(pluginRound(), async () => {
      throw new Error("PRIVATE refused on another replica");
    });
    await userEvent.type(await screen.findByRole("textbox"), "value");
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(outcomes()).toHaveLength(1));
    expect(outcomes()).toEqual([
      expect.objectContaining({ outcome: "failure", error_code: "other" }),
    ]);
  });

  it("records nothing for an ordinary (non-plugin) MRTR round", async () => {
    render(<HostedMrtrHost />);
    enqueue(
      pluginRound({
        pluginFormProfile: undefined,
        pluginFormServiceScope: undefined,
      }),
      async () => {},
    );
    await userEvent.type(await screen.findByRole("textbox"), "value");
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(useHostedMrtrStore.getState().rounds).toHaveLength(0),
    );
    expect(outcomes()).toEqual([]);
  });
});
