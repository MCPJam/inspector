import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import { BehaviorTab } from "../BehaviorTab";
import { ProtocolTab } from "../ProtocolTab";
import { AppsExtensionTab } from "../AppsExtensionTab";

/**
 * Phase 2 of the per-attachment-server-selection plan adds a `readOnly`
 * prop to each Client editor tab so the new AttachmentEditor (Phase 3)
 * can surface the host's profile without letting users edit it inline.
 *
 * These tests are minimal — they verify the prop is wired and the most
 * visible control on each tab respects it. Deeper readOnly behavior
 * (capability-matrix sub-toggles, JSON view-mode forcing) gets exercised
 * organically by HostFocusPanel.test.tsx and downstream callers once
 * Phase 3 sets readOnly={true} on a real surface.
 */
describe("Client editor tabs — readOnly prop wiring", () => {
  it("BehaviorTab readOnly disables the model select", () => {
    render(
      <BehaviorTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        readOnly
      />,
    );
    const modelSelect = screen.getByRole("combobox") as HTMLSelectElement;
    expect(modelSelect).toBeDisabled();
  });

  it("BehaviorTab readOnly disables the system-prompt textarea", () => {
    render(
      <BehaviorTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        readOnly
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "You are a helpful assistant…",
    ) as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute("readonly");
  });

  it("BehaviorTab readOnly disables tool-approval and visibility switches", () => {
    render(
      <BehaviorTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        readOnly
      />,
    );
    const approval = screen.getByRole("switch", {
      name: /require tool approval/i,
    });
    const visibility = screen.getAllByRole("switch", {
      name: /respect tool visibility/i,
    })[0];
    expect(approval).toBeDisabled();
    expect(visibility).toBeDisabled();
  });

  it("BehaviorTab without readOnly leaves controls enabled (sanity check)", () => {
    render(
      <BehaviorTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
      />,
    );
    const modelSelect = screen.getByRole("combobox") as HTMLSelectElement;
    expect(modelSelect).not.toBeDisabled();
  });

  it("AppsExtensionTab readOnly wraps the body in a disabled fieldset", () => {
    const { container } = render(
      <AppsExtensionTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
        readOnly
      />,
    );
    const fieldset = container.querySelector("fieldset");
    expect(fieldset).not.toBeNull();
    expect(fieldset).toBeDisabled();
  });

  it("AppsExtensionTab without readOnly renders an enabled fieldset", () => {
    const { container } = render(
      <AppsExtensionTab
        draft={emptyHostConfigInputV2()}
        onDraftChange={vi.fn()}
        attention={[]}
      />,
    );
    const fieldset = container.querySelector("fieldset");
    expect(fieldset).not.toBeNull();
    expect(fieldset).not.toBeDisabled();
  });

  it("ProtocolTab accepts the readOnly prop without throwing", () => {
    // ProtocolTab gates Select via `disabled` and forces JsonEditor to
    // `mode="view"` + `readOnly={true}`. Direct interaction with the
    // CodeMirror-backed JsonEditor is brittle in JSDOM, so this test
    // verifies the prop wiring lands cleanly without asserting on the
    // editor's internal state.
    expect(() =>
      render(
        <ProtocolTab
          draft={emptyHostConfigInputV2()}
          onDraftChange={vi.fn()}
          attention={[]}
          readOnly
        />,
      ),
    ).not.toThrow();
  });
});
