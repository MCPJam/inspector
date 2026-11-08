import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  emptyHostConfigInputV2,
  hostConfigInputsEqual,
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

import { AppsExtensionTab } from "../AppsExtensionTab";
import { addHostTemplateDefaults } from "../host-template-defaults";

function Harness({ initial }: { initial: HostConfigInputV2 }) {
  const [draft, setDraft] = useState(initial);
  const dirty = !hostConfigInputsEqual(draft, initial);
  return (
    <div>
      <div data-testid="dirty">{dirty ? "dirty" : "clean"}</div>
      <AppsExtensionTab
        draft={draft}
        onDraftChange={(updater) => setDraft((prev) => updater(prev))}
        attention={[]}
      />
    </div>
  );
}

function mcpjamHost(): HostConfigInputV2 {
  return emptyHostConfigInputV2({
    hostStyle: "mcpjam",
    clientCapabilities: {
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html", "text/uri-list"],
        },
      },
    },
  } as Partial<HostConfigInputV2>);
}

describe("AppsExtensionTab arms the Save gate on edit", () => {
  it("editing hostContext marks the draft dirty", async () => {
    const user = userEvent.setup();
    render(<Harness initial={mcpjamHost()} />);
    expect(screen.getByTestId("dirty").textContent).toBe("clean");

    const textarea = screen.getByLabelText("json") as HTMLTextAreaElement;
    const current = JSON.parse(textarea.value);
    current.hostContext = { locale: "en-US" };
    await user.clear(textarea);
    await user.paste(JSON.stringify(current, null, 2));

    expect(screen.getByTestId("dirty").textContent).toBe("dirty");
  });

  it("editing an extension mimeType marks the draft dirty", async () => {
    const user = userEvent.setup();
    render(<Harness initial={mcpjamHost()} />);
    expect(screen.getByTestId("dirty").textContent).toBe("clean");

    const textarea = screen.getByLabelText("json") as HTMLTextAreaElement;
    const current = JSON.parse(textarea.value);
    current.extensions["io.modelcontextprotocol/ui"].mimeTypes = ["text/html"];
    await user.clear(textarea);
    await user.paste(JSON.stringify(current, null, 2));

    expect(screen.getByTestId("dirty").textContent).toBe("dirty");
  });
});

function DefaultsHarness() {
  const [draft, setDraft] = useState(() =>
    emptyHostConfigInputV2({
      hostStyle: "chatgpt",
      mcpProfile: {
        profileVersion: 1,
        apps: {
          pluginExtensions: {
            capabilities: { mentions: false },
            enabled: true,
          },
        },
      },
    }),
  );
  return (
    <>
      <button
        onClick={() =>
          setDraft((prev) =>
            addHostTemplateDefaults(
              {
                ...prev,
                mcpProfile: {
                  profileVersion: 1,
                  apps: {
                    pluginExtensions: {
                      enabled: true,
                      capabilities: { mentions: true },
                    },
                  },
                },
              },
              prev,
            ),
          )
        }
      >
        Add defaults
      </button>
      <AppsExtensionTab
        draft={draft}
        onDraftChange={(updater) => setDraft(updater)}
      />
    </>
  );
}

describe("Apps JSON after adding profile defaults", () => {
  it("refreshes an accepted edit even when the parser reordered object keys", async () => {
    render(<DefaultsHarness />);
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "json",
    });
    const doc = JSON.parse(editor.value);
    doc.pluginExtensions = { capabilities: { forms: false }, enabled: true };
    fireEvent.change(editor, {
      target: { value: JSON.stringify(doc, null, 2) },
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Add defaults" }));
    expect(JSON.parse(editor.value).pluginExtensions).toEqual({
      enabled: true,
      capabilities: { mentions: true, forms: false },
    });
  });

  it("keeps an incomplete JSON edit when defaults change outside the editor", async () => {
    render(<DefaultsHarness />);
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "json",
    });
    fireEvent.change(editor, { target: { value: '{"hostContext":' } });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Add defaults" }));
    expect(editor.value).toBe('{"hostContext":');
  });
});
