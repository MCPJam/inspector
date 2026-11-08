import { useLayoutEffect, useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  rows: [] as unknown[],
  owner: "actor",
  action: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useConvex: () => ({ mutation: f.mutate, action: f.action }),
  useQuery: (name: string) =>
    name === "users:getCurrentUser" ? { _id: f.owner } : f.rows,
}));
vi.mock("@/lib/apis/web/base", () => ({
  webPost: async () => ({ ok: true, storageId: "answer" }),
}));
import { OwnedPluginFormHost } from "../OwnedPluginFormHost";
import { ElicitationDialog } from "../../ElicitationDialog";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { TakeoverFormSlot } from "../TakeoverFormSlot";
import {
  __resetComposerFormStore,
  registerComposerSlot,
  useComposerForms,
} from "../composer-form-store";

const request = () => ({
  rendezvousId: "request",
  serverId: "server",
  serverName: "CAD",
  mode: "form",
  formDialect: "openai",
  pluginWorkspaceId: "global",
  message: "Review",
  requestedSchema: {
    type: "object",
    properties: { approved: { type: "boolean" } },
  },
  expiresAt: Date.now() + 60000,
});
afterEach(() => {
  cleanup();
  __resetComposerFormStore();
  f.rows = [];
  f.owner = "actor";
  f.mutate.mockReset();
  f.action.mockReset();
  history.replaceState({}, "", "/");
  document.body.innerHTML = "";
});
const ui = (takeover: boolean) => (
  <>
    <ElicitationDialog elicitationRequest={null} onResponse={async () => {}} />
    <TakeoverFormSlot />
    <button>Open App review</button>
    <OwnedPluginFormHost projectId="project" workspaceId="global" />
    {takeover && (
      <TakeoverFormSlot globalWorkspaceId="global" chatWorkspaceId="chat" />
    )}
  </>
);
it.each([false, true])(
  "returns focus after cancelling the real owned form (takeover %s)",
  async (takeover) => {
    f.mutate.mockResolvedValue({ ok: true });
    const view = render(ui(takeover));
    const opener = screen.getByRole("button", { name: "Open App review" });
    opener.focus();
    f.rows = [request()];
    view.rerender(ui(takeover));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const close = takeover
      ? screen.getByRole("button", { name: "Close", exact: true })
      : screen.getByRole("button", { name: "Cancel", exact: true });
    fireEvent.click(close);
    await waitFor(() => expect(f.mutate).toHaveBeenCalledOnce());
    f.rows = [];
    view.rerender(ui(takeover));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  },
);
it("returns to the same registered composer when the App opener is removed", async () => {
  f.mutate.mockResolvedValue({ ok: true });
  const composer = document.createElement("div");
  const slot = document.createElement("div");
  const input = document.createElement("textarea");
  input.setAttribute("data-chat-composer-input", "");
  input.value = "keep this draft";
  composer.append(slot, input);
  document.body.append(composer);
  const release = registerComposerSlot("chat", slot);
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frame.focus();
  const view = render(ui(true));
  f.rows = [request()];
  view.rerender(ui(true));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  frame.remove();
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  await waitFor(() => expect(f.mutate).toHaveBeenCalledOnce());
  f.rows = [];
  view.rerender(ui(true));
  await waitFor(() => expect(input).toHaveFocus());
  expect(input.value).toBe("keep this draft");
  act(release);
});

it("restores the opener after a completed answer", async () => {
  f.mutate.mockResolvedValue({ ok: true });
  const view = render(ui(true));
  const opener = screen.getByRole("button", { name: "Open App review" });
  opener.focus();
  f.rows = [request()];
  view.rerender(ui(true));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Continue", exact: true }),
    ).toBeInTheDocument(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Continue", exact: true }),
  );
  await waitFor(() => expect(f.mutate).toHaveBeenCalledOnce());
  f.rows = [];
  view.rerender(ui(true));
  await waitFor(() => expect(opener).toHaveFocus());
});
it.each(["actor", "route"])(
  "does not restore into a changed %s scope",
  async (changed) => {
    const view = render(ui(true));
    const opener = screen.getByRole("button", { name: "Open App review" });
    opener.focus();
    f.rows = [request()];
    view.rerender(ui(true));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    if (changed === "actor") f.owner = "another-actor";
    else history.replaceState({}, "", "/another-project");
    f.rows = [];
    view.rerender(ui(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(opener).not.toHaveFocus();
  },
);
it("leaves the next dialog's focus alone", async () => {
  const view = render(ui(true));
  const opener = screen.getByRole("button", { name: "Open App review" });
  opener.focus();
  f.rows = [request()];
  view.rerender(ui(true));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  f.rows = [];
  view.rerender(
    <>
      {ui(true)}
      <Dialog open>
        <DialogContent>
          <DialogTitle>New owner</DialogTitle>
          <button>New action</button>
        </DialogContent>
      </Dialog>
    </>,
  );
  const next = screen.getByRole("button", { name: "New action" });
  next.focus();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(next).toHaveFocus();
  expect(opener).not.toHaveFocus();
});
it("does not reuse a composer slot now registered to another workspace", async () => {
  const region = document.createElement("div"),
    slot = document.createElement("div"),
    input = document.createElement("textarea");
  input.setAttribute("data-chat-composer-input", "");
  region.append(slot, input);
  document.body.append(region);
  const release = registerComposerSlot("chat", slot);
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frame.focus();
  const view = render(ui(true));
  f.rows = [request()];
  view.rerender(ui(true));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  frame.remove();
  act(release);
  let foreign!: () => void;
  act(() => {
    foreign = registerComposerSlot("foreign", slot);
  });
  f.rows = [];
  view.rerender(ui(true));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(input).not.toHaveFocus();
  act(foreign);
});

it("captures a newly focused opener when a persistent idle dialog receives its request", async () => {
  const complete = vi.fn();
  const draw = (open: boolean) => (
    <>
      <button>Fresh opener</button>
      <ElicitationDialog
        elicitationRequest={
          open
            ? {
                requestId: "ordinary",
                message: "Ordinary",
                schema: { type: "object", properties: {} },
              }
            : null
        }
        onResponse={complete}
      />
    </>
  );
  const view = render(draw(false));
  const opener = screen.getByRole("button", { name: "Fresh opener" });
  opener.focus();
  view.rerender(draw(true));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  view.rerender(draw(false));
  await waitFor(() => expect(opener).toHaveFocus());
});
it("keeps an inline-started form's actor fence when it moves into takeover", async () => {
  const background = document.createElement("div");
  document.body.append(background);
  const release = registerComposerSlot("global", background);
  const view = render(ui(true));
  const opener = screen.getByRole("button", { name: "Open App review" });
  opener.focus();
  f.rows = [request()];
  view.rerender(ui(true));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  f.owner = "foreign-actor";
  f.rows = [];
  view.rerender(ui(true));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(opener).not.toHaveFocus();
  act(release);
});

it.each(["pending", "failed"])(
  "restores the opener when cancelling a %s private schema dialog",
  async (state) => {
    f.mutate.mockResolvedValue({ ok: true });
    if (state === "pending") f.action.mockReturnValue(new Promise(() => {}));
    else f.action.mockRejectedValue(new Error("Schema unavailable"));
    const view = render(ui(false));
    const opener = screen.getByRole("button", { name: "Open App review" });
    opener.focus();
    f.rows = [
      { ...request(), requestedSchema: undefined, hasPrivateSchema: true },
    ];
    view.rerender(ui(false));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    if (state === "failed")
      await screen.findByRole("button", { name: "Retry", exact: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel", exact: true }),
    );
    await waitFor(() => expect(f.mutate).toHaveBeenCalledOnce());
    f.rows = [];
    view.rerender(ui(false));
    await waitFor(() => expect(opener).toHaveFocus());
  },
);

function InlineSettings({ active = true }: { active?: boolean }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => registerComposerSlot("global", slot.current!), []);
  const forms = useComposerForms("global");
  return (
    <>
      <section hidden={forms.length > 0}>
        <textarea
          data-chat-composer-input
          defaultValue="retained draft"
          aria-label="Draft"
        />
        <button>Settings review</button>
      </section>
      <div ref={slot} />
      <OwnedPluginFormHost
        projectId="project"
        workspaceId="global"
        active={active}
      />
    </>
  );
}
it.each(["cancel", "accept"])(
  "restores the inline Settings opener after %s and preserves its draft",
  async (action) => {
    f.mutate.mockResolvedValue({ ok: true });
    const view = render(<InlineSettings />);
    const opener = screen.getByRole("button", { name: "Settings review" });
    opener.focus();
    f.rows = [request()];
    view.rerender(<InlineSettings />);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Settings review" }),
      ).toBeNull(),
    );
    const actionButton = screen.getByRole("button", {
      name: action === "cancel" ? "Close" : "Continue",
      exact: true,
    });
    actionButton.focus();
    fireEvent.click(actionButton);
    await waitFor(() => expect(f.mutate).toHaveBeenCalledOnce());
    f.rows = [];
    view.rerender(<InlineSettings />);
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue(
      "retained draft",
    );
  },
);
it("does not restore focus when a retained inline form is only hidden", async () => {
  const view = render(
    <>
      <InlineSettings />
      <button>Other chat</button>
    </>,
  );
  const opener = screen.getByRole("button", { name: "Settings review" });
  opener.focus();
  f.rows = [request()];
  view.rerender(
    <>
      <InlineSettings />
      <button>Other chat</button>
    </>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Continue", exact: true }),
    ).toBeInTheDocument(),
  );
  const other = screen.getByRole("button", { name: "Other chat" });
  other.focus();
  view.rerender(
    <>
      <InlineSettings active={false} />
      <button>Other chat</button>
    </>,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(other).toHaveFocus();
});
