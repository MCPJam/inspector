import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { AppsExtensionTab, applyJsonToDraft } from "../AppsExtensionTab";

function renderTab(initial?: Partial<HostConfigInputV2>) {
  const draftRef: { current: HostConfigInputV2 } = {
    current: emptyHostConfigInputV2({ hostStyle: "chatgpt", ...initial }),
  };
  function Harness({ initialDraft }: { initialDraft: HostConfigInputV2 }) {
    const [draft, setDraft] = useState<HostConfigInputV2>(initialDraft);
    draftRef.current = draft;
    return (
      <AppsExtensionTab
        draft={draft}
        onDraftChange={(updater) =>
          setDraft((prev) => {
            const next = updater(prev);
            draftRef.current = next;
            return next;
          })
        }
        attention={[]}
      />
    );
  }
  render(<Harness initialDraft={draftRef.current} />);
  return { draftRef };
}

const card = () => screen.getByTestId("plugin-extensions-card");

describe("AppsExtensionTab — OpenAI plugin extensions", () => {
  it("is on for the ChatGPT style by default and writes an explicit off", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderTab();
    const master = within(card()).getByRole("switch", {
      name: "OpenAI plugin extensions",
    });
    expect(master).toBeChecked();
    expect(draftRef.current.mcpProfile).toBeUndefined();

    await user.click(master);
    expect(draftRef.current.mcpProfile?.apps?.pluginExtensions).toEqual({
      enabled: false,
    });
    expect(master).not.toBeChecked();
  });

  it("is off for a ChatGPT-family style like Cursor", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderTab({ hostStyle: "cursor" });
    const master = within(card()).getByRole("switch", {
      name: "OpenAI plugin extensions",
    });
    expect(master).not.toBeChecked();
    expect(within(card()).getByText(/0 of 13 on/)).toBeInTheDocument();

    await user.click(master);
    expect(draftRef.current.mcpProfile?.apps?.pluginExtensions).toEqual({
      enabled: true,
    });
    // Off again on an off-by-default style collapses to "not set".
    await user.click(master);
    expect(draftRef.current.mcpProfile).toBeUndefined();
  });

  it("stores only the extensions switched off", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderTab({ hostStyle: "codex" });
    await user.click(within(card()).getByRole("button", { name: /Extensions/ }));
    await user.click(within(card()).getByRole("switch", { name: "Mentions" }));
    expect(draftRef.current.mcpProfile?.apps?.pluginExtensions).toEqual({
      enabled: true,
      capabilities: { mentions: false },
    });
    expect(within(card()).getByText(/12 of 13 on/)).toBeInTheDocument();

    await user.click(within(card()).getByRole("switch", { name: "Mentions" }));
    expect(draftRef.current.mcpProfile?.apps?.pluginExtensions).toEqual({
      enabled: true,
    });
  });

  it("switching one extension on while all are off enables only that one", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderTab({ hostStyle: "vscode" });
    await user.click(within(card()).getByRole("button", { name: /Extensions/ }));
    await user.click(within(card()).getByRole("switch", { name: "Forms" }));
    const saved = draftRef.current.mcpProfile?.apps?.pluginExtensions;
    expect(saved?.enabled).toBe(true);
    expect(saved?.capabilities?.forms).toBeUndefined();
    expect(Object.values(saved?.capabilities ?? {}).every((v) => !v)).toBe(
      true,
    );
    expect(Object.keys(saved?.capabilities ?? {})).toHaveLength(12);
  });

  it("round-trips through the JSON editor instead of being wiped", () => {
    const prev = emptyHostConfigInputV2({
      hostStyle: "codex",
      mcpProfile: {
        profileVersion: 1,
        apps: {
          pluginExtensions: { enabled: true, capabilities: { forms: false } },
        },
      },
    });
    const kept = applyJsonToDraft(
      {
        hostContext: {},
        pluginExtensions: {
          enabled: true,
          capabilities: { forms: false, bogus: false, mentions: "no" },
        },
      },
      prev,
    );
    expect(kept?.mcpProfile?.apps?.pluginExtensions).toEqual({
      enabled: true,
      capabilities: { forms: false },
    });

    const removed = applyJsonToDraft({ hostContext: {} }, prev);
    expect(removed?.mcpProfile?.apps?.pluginExtensions).toBeUndefined();
  });
});
