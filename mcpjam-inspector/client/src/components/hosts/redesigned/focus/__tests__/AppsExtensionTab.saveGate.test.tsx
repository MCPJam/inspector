import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
