import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ rows: [] as unknown[], mutate: vi.fn() }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useConvex: () => ({ mutation: f.mutate }),
  useQuery: (name: string) =>
    name === "users:getCurrentUser" ? { _id: "actor" } : f.rows,
}));
vi.mock("@/lib/apis/web/base", () => ({
  webPost: async () => ({ ok: true, storageId: "answer" }),
}));
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { OwnedPluginFormHost } from "../OwnedPluginFormHost";
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
  pluginWorkspaceId: "settings",
  message: "Review",
  requestedSchema: {
    type: "object",
    properties: { approved: { type: "boolean" } },
  },
  expiresAt: Date.now() + 60000,
});
function Settings({ openerRemoved = false }: { openerRemoved?: boolean }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => registerComposerSlot("settings", slot.current!), []);
  const forms = useComposerForms("settings");
  return (
    <>
      <section hidden={forms.length > 0}>
        <textarea
          data-chat-composer-input
          aria-label="Draft"
          defaultValue="saved draft"
        />
        {!openerRemoved && <button>Review preferences</button>}
      </section>
      <div ref={slot} />
      <OwnedPluginFormHost projectId="project" workspaceId="settings" />
    </>
  );
}
const ui = (openerRemoved = false, other = false) => (
  <>
    <Dialog open>
      <DialogContent showCloseButton={false}>
        <DialogTitle>Server details</DialogTitle>
        <Settings openerRemoved={openerRemoved} />
      </DialogContent>
    </Dialog>
    {other && (
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Another dialog</DialogTitle>
          <button>Another action</button>
        </DialogContent>
      </Dialog>
    )}
  </>
);
afterEach(() => {
  cleanup();
  __resetComposerFormStore();
  f.rows = [];
  f.mutate.mockReset();
});
it.each(["accept", "cancel"])(
  "restores the Settings opener inside its still-open parent dialog after %s",
  async (action) => {
    f.mutate.mockResolvedValue({ ok: true });
    const view = render(ui());
    const opener = await screen.findByRole("button", {
      name: "Review preferences",
    });
    opener.focus();
    f.rows = [request()];
    view.rerender(ui());
    const button = await screen.findByRole("button", {
      name: action === "accept" ? "Continue" : "Close",
      exact: true,
    });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(f.mutate).toHaveBeenCalledOnce());
    f.rows = [];
    view.rerender(ui());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(
      screen.getByRole("dialog", { name: "Server details" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue(
      "saved draft",
    );
  },
);
it("restores only the original parent's composer if its opener was removed", async () => {
  f.mutate.mockResolvedValue({ ok: true });
  const view = render(ui());
  screen.getByRole("button", { name: "Review preferences" }).focus();
  f.rows = [request()];
  view.rerender(ui(true));
  const close = await screen.findByRole("button", {
    name: "Close",
    exact: true,
  });
  close.focus();
  fireEvent.click(close);
  await waitFor(() => expect(f.mutate).toHaveBeenCalledOnce());
  f.rows = [];
  view.rerender(ui(true));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveFocus(),
  );
});
it("does not take focus from a competing dialog above Server details", async () => {
  const view = render(ui());
  screen.getByRole("button", { name: "Review preferences" }).focus();
  f.rows = [request()];
  view.rerender(ui());
  await screen.findByRole("button", { name: "Continue", exact: true });
  f.rows = [];
  view.rerender(ui(false, true));
  const other = screen.getByRole("button", { name: "Another action" });
  other.focus();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(other).toHaveFocus();
});
it("preserves meaningful focus already placed in the original parent", async () => {
  const view = render(ui());
  screen.getByRole("button", { name: "Review preferences" }).focus();
  f.rows = [request()];
  view.rerender(ui());
  await screen.findByRole("button", { name: "Continue", exact: true });
  f.rows = [];
  view.rerender(ui());
  const draft = screen.getByRole("textbox", { name: "Draft" });
  draft.focus();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(draft).toHaveFocus();
});

it("uses the original parent composer when the parent container held focus", async () => {
  f.mutate.mockResolvedValue({ ok: true });
  const view = render(ui());
  screen.getByRole("dialog", { name: "Server details" }).focus();
  f.rows = [request()];
  view.rerender(ui());
  const close = await screen.findByRole("button", {
    name: "Close",
    exact: true,
  });
  close.focus();
  fireEvent.click(close);
  await waitFor(() => expect(f.mutate).toHaveBeenCalledOnce());
  f.rows = [];
  view.rerender(ui());
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveFocus(),
  );
});
