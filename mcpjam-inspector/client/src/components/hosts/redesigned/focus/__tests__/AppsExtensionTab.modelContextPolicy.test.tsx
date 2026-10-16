import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({
    rawContent,
    onRawChange,
  }: {
    rawContent: string;
    onRawChange: (next: string) => void;
  }) => (
    <textarea
      aria-label="json"
      value={rawContent}
      onChange={(e) => onRawChange(e.target.value)}
    />
  ),
}));

import { AppsExtensionTab, applyJsonToDraft } from "../AppsExtensionTab";

const policy = { maxBlocks: 256, updateMaxBytes: 2_548_000 };

function chatgptWithPolicy(): HostConfigInputV2 {
  return emptyHostConfigInputV2({
    hostStyle: "chatgpt",
    mcpProfile: { profileVersion: 1, apps: { modelContextPolicy: policy } },
  });
}

describe("AppsExtensionTab — modelContextPolicy", () => {
  it("shows the saved policy and keeps it through an unrelated JSON edit", async () => {
    const user = userEvent.setup();
    const draftRef: { current: HostConfigInputV2 } = {
      current: chatgptWithPolicy(),
    };
    function Harness() {
      const [draft, setDraft] = useState(draftRef.current);
      draftRef.current = draft;
      return (
        <AppsExtensionTab
          draft={draft}
          onDraftChange={(updater) => setDraft((prev) => updater(prev))}
          attention={[]}
        />
      );
    }
    render(<Harness />);

    const textarea = screen.getByLabelText("json") as HTMLTextAreaElement;
    const doc = JSON.parse(textarea.value);
    expect(doc.modelContextPolicy).toEqual(policy);

    doc.hostContext = { locale: "en-US" };
    await user.clear(textarea);
    await user.paste(JSON.stringify(doc, null, 2));

    expect(draftRef.current.hostContext).toEqual({ locale: "en-US" });
    expect(draftRef.current.mcpProfile?.apps?.modelContextPolicy).toEqual(
      policy,
    );
  });

  it("keeps typed budgets, drops unknown keys, and clears when removed", () => {
    const prev = chatgptWithPolicy();
    const kept = applyJsonToDraft(
      {
        hostContext: {},
        modelContextPolicy: {
          turnMaxBytes: 9_000_000,
          maxBlocks: "256",
          images: "placeholder",
        },
      },
      prev,
    );
    // Over the ceiling, but kept: the save reports it instead of losing it.
    expect(kept?.mcpProfile?.apps?.modelContextPolicy).toEqual({
      turnMaxBytes: 9_000_000,
    });

    const removed = applyJsonToDraft({ hostContext: {} }, prev);
    expect(removed?.mcpProfile?.apps?.modelContextPolicy).toBeUndefined();
  });
});
