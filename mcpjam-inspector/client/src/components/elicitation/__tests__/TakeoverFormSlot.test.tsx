import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerFormCard } from "../ComposerFormCard";
import { compilePluginForm } from "@/shared/plugin-extensions/form-plan";
import { useRetainedFormPortal } from "../use-retained-form-portal";
import { TakeoverFormSlot } from "../TakeoverFormSlot";
import {
  __resetComposerFormStore,
  registerComposerForm,
  registerComposerSlot,
  useComposerSlot,
} from "../composer-form-store";

function FormOwner({ workspaceId }: { workspaceId: string }) {
  const slot = useComposerSlot(workspaceId);
  const portal = useRetainedFormPortal(slot);
  return portal.ready ? createPortal(<input aria-label={workspaceId} defaultValue="draft" />, portal.target) : null;
}

afterEach(() => {
  cleanup();
  __resetComposerFormStore();
});

describe("global App pending form presentation", () => {
  it("moves the existing owner into the visible slot and restores the chat slot on exit", () => {
    const background = document.createElement("div");
    document.body.append(background);
    const releaseSlot = registerComposerSlot("chat", background);
    const releaseForm = registerComposerForm({ id: "first", workspaceId: "chat", serverName: "CAD", cancel: () => undefined });
    const view = render(<><FormOwner workspaceId="chat" /><TakeoverFormSlot chatWorkspaceId="chat" globalWorkspaceId="global" /></>);
    expect(screen.getByTestId("takeover-form-slot").querySelector("input")).not.toBeNull();
    expect(background.querySelector("input")).toBeNull();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    view.rerender(<FormOwner workspaceId="chat" />);
    expect(background.querySelector("input")).not.toBeNull();
    releaseForm();
    releaseSlot();
    background.remove();
  });

  it("preserves edited answers across takeover and return and allows cancellation", async () => {
    const background = document.createElement("div");
    document.body.append(background);
    const releaseSlot = registerComposerSlot("chat", background);
    const releaseForm = registerComposerForm({ id: "draft", workspaceId: "chat", serverName: "CAD", cancel: () => undefined });
    const respond = vi.fn(async () => { releaseForm(); });
    const plan = compilePluginForm({ type: "object", properties: { name: { type: "string", title: "Name" } } }, { fileResources: false, userResources: false, previews: false, origin: "server" });
    function CardOwner() {
      const slot = useComposerSlot("chat");
      const portal = useRetainedFormPortal(slot);
      return portal.ready ? createPortal(<ComposerFormCard requestId="draft" title="Review" serverName="CAD" plan={plan} onRespond={respond} />, portal.target) : null;
    }
    const view = render(<CardOwner />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "before takeover" } });
    view.rerender(<><CardOwner /><TakeoverFormSlot chatWorkspaceId="chat" /></>);
    expect(screen.getByRole("textbox")).toHaveValue("before takeover");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "inside takeover" } });
    view.rerender(<CardOwner />);
    expect(screen.getByRole("textbox")).toHaveValue("inside takeover");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("cancel", undefined));
    releaseSlot();
    background.remove();
  });

  it("queues chat and global forms by arrival, without selecting another chat's form", () => {
    registerComposerForm({ id: "other", workspaceId: "other-chat", serverName: "Other", cancel: () => undefined });
    const release = registerComposerForm({ id: "global", workspaceId: "global", serverName: "CAD", cancel: () => undefined });
    registerComposerForm({ id: "chat", workspaceId: "chat", serverName: "Parts", cancel: () => undefined });
    render(<><FormOwner workspaceId="global" /><FormOwner workspaceId="chat" /><TakeoverFormSlot chatWorkspaceId="chat" globalWorkspaceId="global" /></>);
    expect(screen.getByRole("textbox").getAttribute("aria-label")).toBe("global");
    expect(screen.queryByText("Other requests information")).toBeNull();
    act(release);
    expect(screen.getByRole("textbox").getAttribute("aria-label")).toBe("chat");
  });
});
