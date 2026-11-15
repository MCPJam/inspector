import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { useNativeHarnessLimitDialogStore } from "@/stores/native-harness-limit-dialog-store";
import {
  HostHarnessChoice,
  harnessUnavailableReason,
  type ClientHarnessChoice,
} from "../HostHarnessChoice";

const softQueryMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-soft-query", () => ({
  useSoftQuery: (...args: unknown[]) => softQueryMock(...args),
}));

const setClientHarnessMock = vi.hoisted(() => vi.fn());
vi.mock("convex/react", () => ({
  useMutation: () => setClientHarnessMock,
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));

function choice(overrides: Partial<ClientHarnessChoice> = {}): ClientHarnessChoice {
  return {
    current: "mcpjam",
    native: "codex",
    nativeAvailable: true,
    unavailableReason: null,
    canEdit: true,
    trial: { applies: true, granted: 20, used: 8, remaining: 12 },
    ...overrides,
  };
}

function renderChoice(
  answer: ClientHarnessChoice | null | undefined,
  props: Partial<Parameters<typeof HostHarnessChoice>[0]> = {},
) {
  softQueryMock.mockReturnValue({ data: answer, error: undefined });
  return render(
    <HostHarnessChoice
      hostId="host_1"
      isDirty={false}
      readOnly={false}
      modelLabel="GPT-6 Luna"
      {...props}
    />,
  );
}

const chip = (name: RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
  softQueryMock.mockReset();
  setClientHarnessMock.mockReset();
  setClientHarnessMock.mockResolvedValue(choice());
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  useNativeHarnessLimitDialogStore.setState({
    notice: null,
    notifiedKeys: new Set(),
  });
});

afterEach(() => {
  useNativeHarnessLimitDialogStore.getState().close();
});

describe("HostHarnessChoice", () => {
  // The backend answers null for a client with no native runtime, a user
  // without the feature, or a client they can't read.
  it("shows nothing when the backend gives no choice, or while loading", () => {
    expect(renderChoice(null).container).toBeEmptyDOMElement();
    expect(renderChoice(undefined).container).toBeEmptyDOMElement();
    expect(softQueryMock).toHaveBeenCalledWith(
      "clientHarness:getClientHarnessChoice",
      { hostId: "host_1" },
    );
  });

  it("offers both harnesses, with a Free organization's turns on the native one", () => {
    renderChoice(choice());

    expect(screen.getByText("Harness")).toBeInTheDocument();
    expect(chip(/^MCPJam Harness$/)).toHaveAttribute("aria-pressed", "true");
    expect(chip(/^MCPJam Harness$/)).toHaveClass("hp-cap--selected");
    const native = chip(/Codex App Server/);
    expect(native).toHaveAttribute("aria-pressed", "false");
    expect(native).toHaveTextContent("12 / 20 turns left");
    expect(native).not.toHaveClass("hp-cap--off");
  });

  it("shows no count to a paid organization", () => {
    renderChoice(
      choice({
        current: "native",
        trial: { applies: false, granted: 20, used: 0, remaining: 20 },
      }),
    );

    expect(chip(/Codex App Server/)).toHaveAttribute("aria-pressed", "true");
    expect(chip(/Codex App Server/)).not.toHaveTextContent("turns left");
  });

  it("saves a pick at once and says what new chats use", async () => {
    renderChoice(choice());

    await userEvent.click(chip(/Codex App Server/));

    expect(setClientHarnessMock).toHaveBeenCalledWith({
      hostId: "host_1",
      choice: "native",
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      "New chats use Codex App Server.",
    );
  });

  it("switches back to MCPJam Harness the same way, and ignores the current pick", async () => {
    renderChoice(choice({ current: "native", native: "claude-code" }));

    await userEvent.click(chip(/Claude Agent SDK/));
    expect(setClientHarnessMock).not.toHaveBeenCalled();

    await userEvent.click(chip(/^MCPJam Harness$/));
    expect(setClientHarnessMock).toHaveBeenCalledWith({
      hostId: "host_1",
      choice: "mcpjam",
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      "New chats use MCPJam Harness.",
    );
  });

  // Moving back can keep a computer whose own feature is off for the
  // organization; the backend refuses before it writes anything.
  it("shows a refused switch back in the backend's words", async () => {
    setClientHarnessMock.mockRejectedValue(
      new ConvexError({
        code: "FEATURE_UNAVAILABLE",
        message: "Computers is not currently available for your organization.",
      }),
    );
    renderChoice(choice({ current: "native" }));

    await userEvent.click(chip(/^MCPJam Harness$/));

    expect(setClientHarnessMock).toHaveBeenCalledWith({
      hostId: "host_1",
      choice: "mcpjam",
    });
    expect(toastMock.error).toHaveBeenCalledWith(
      "Computers is not currently available for your organization.",
    );
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(useNativeHarnessLimitDialogStore.getState().notice).toBeNull();
  });

  it("opens the limit dialog instead of saving once the trial is used up", async () => {
    renderChoice(
      choice({
        nativeAvailable: false,
        unavailableReason: "trial_exhausted",
        trial: { applies: true, granted: 20, used: 20, remaining: 0 },
      }),
    );

    expect(chip(/Codex App Server/)).toHaveClass("hp-cap--off");
    expect(
      screen.getByText(
        "Your organization has used its 20 free native harness turns.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(chip(/Codex App Server/));

    expect(setClientHarnessMock).not.toHaveBeenCalled();
    expect(useNativeHarnessLimitDialogStore.getState().notice).toEqual({
      granted: 20,
    });
  });

  it.each([
    ["runtime_unavailable", "Codex App Server isn't available for your account."],
    [
      "cursor_key_missing",
      "Codex App Server needs a Cursor key. Add one in AI providers.",
    ],
    [
      "model_unsupported",
      "Codex App Server can't run GPT-6 Luna. Choose another model in the Agent tab.",
    ],
  ] as const)("says why the runtime can't run: %s", (reason, line) => {
    renderChoice(choice({ nativeAvailable: false, unavailableReason: reason }));

    expect(screen.getByText(line)).toBeInTheDocument();
    expect(chip(/Codex App Server/)).toBeDisabled();
    expect(chip(/Codex App Server/)).not.toHaveTextContent("turns left");
  });

  it("names Cursor CLI in its reasons", () => {
    expect(
      harnessUnavailableReason(
        choice({
          native: "cursor",
          nativeAvailable: false,
          unavailableReason: "cursor_key_missing",
        }),
        null,
      ),
    ).toBe("Cursor CLI needs a Cursor key. Add one in AI providers.");
  });

  it.each([
    [
      "not_project_admin",
      { editBlockedReason: "not_project_admin" },
      "Only project admins can change this client.",
    ],
    [
      "client_locked_by_study",
      { editBlockedReason: "client_locked_by_study" },
      "A study another member made uses this client. Changing it requires Team or Enterprise.",
    ],
    // An older backend sends canEdit alone.
    ["no reason", {}, "Only project admins can change this client."],
  ] as const)(
    "is disabled when the user can't change it, and says why: %s",
    async (_label, blocked, tooltip) => {
      renderChoice(choice({ canEdit: false, ...blocked }));

      expect(chip(/^MCPJam Harness$/)).toBeDisabled();
      expect(chip(/Codex App Server/)).toBeDisabled();
      await userEvent.hover(screen.getByRole("group", { name: "Harness" }));
      expect(await screen.findByRole("tooltip")).toHaveTextContent(tooltip);
    },
  );

  it("waits for the client's unsaved edits", async () => {
    renderChoice(choice(), { isDirty: true });

    expect(chip(/Codex App Server/)).toBeDisabled();
    await userEvent.hover(screen.getByRole("group", { name: "Harness" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Save or discard your changes first.",
    );
  });

  it("opens the limit dialog when the save itself is refused for the trial", async () => {
    setClientHarnessMock.mockRejectedValue(
      new ConvexError({
        code: "native_harness_trial_exhausted",
        message:
          "This organization has used its 20 free native harness turns. Upgrade your plan to keep using them, or switch to MCPJam Harness.",
      }),
    );
    renderChoice(choice());

    await userEvent.click(chip(/Codex App Server/));

    expect(useNativeHarnessLimitDialogStore.getState().notice).toEqual({
      granted: 20,
    });
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  // The backend's own refusals for this mutation, as it words them.
  it.each([
    [
      "not_project_admin",
      "Only project admins can change this client's harness. Ask a project admin to switch it.",
    ],
    [
      "runtime_unavailable",
      "This client has no native harness you can use. Keep it on MCPJam Harness.",
    ],
    [
      "model_unsupported",
      "This client's native harness can't run its model. Choose another model in the Agent tab, then try again.",
    ],
    ["NOT_FOUND", "This client isn't available to you. Choose another client."],
  ])("shows a %s refusal in the backend's words", async (code, message) => {
    setClientHarnessMock.mockRejectedValue(new ConvexError({ code, message }));
    renderChoice(choice());

    await userEvent.click(chip(/Codex App Server/));

    expect(toastMock.error).toHaveBeenCalledWith(message);
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(useNativeHarnessLimitDialogStore.getState().notice).toBeNull();
  });

  it("names the current harness as a label on a read-only canvas", () => {
    renderChoice(choice({ current: "native" }), { readOnly: true });

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("host-harness-choice")).toHaveTextContent(
      "HarnessCodex App Server",
    );
    // In the card's chip row, so the label keeps a chip's width.
    expect(screen.getByText("Codex App Server").closest(".hp-caps")).not.toBeNull();
  });
});
