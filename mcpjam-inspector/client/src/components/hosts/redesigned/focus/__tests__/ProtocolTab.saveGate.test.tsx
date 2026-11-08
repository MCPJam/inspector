import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  emptyHostConfigInputV2,
  hostConfigInputsEqual,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import {
  collectHostAttentionIssues,
  hasBlockingErrors,
} from "../useHostDraftValidation";

// Regression guard for the Discord "Save host stays greyed after editing the
// MCP Protocol config" report. Proves that a protocol-config edit alone arms
// the exact production Save gate — no agent model required.
//
// Replace the heavy CodeMirror JSON editor with a plain textarea that
// forwards edits through onRawChange — the exact contract ProtocolTab relies
// on. This isolates the dirty-state logic from editor internals.
vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({
    rawContent,
    onRawChange,
    error,
  }: {
    rawContent: string;
    onRawChange: (next: string) => void;
    error?: string | null;
  }) => (
    <>
    {error && <p role="alert">{error}</p>}
    <textarea
      aria-label="json"
      value={rawContent}
      onChange={(e) => onRawChange(e.target.value)}
    />
    </>
  ),
}));

import { ProtocolTab, protocolToJson, applyJsonToDraft } from "../ProtocolTab";

// Mirror HostBuilderViewRedesigned's exact save gate:
//   canSave = isDirty && !isSaving && !hasBlockingErrors(attention)
// with a host that has NO model (modelId === "") — the reporter's case.
function Harness({
  initial,
  hostName = "My host",
}: {
  initial: HostConfigInputV2;
  hostName?: string;
}) {
  const [draft, setDraft] = useState(initial);
  const dirty = !hostConfigInputsEqual(draft, initial);
  const attention = collectHostAttentionIssues(draft, hostName);
  const canSave = dirty && !hasBlockingErrors(attention);
  return (
    <div>
      <div data-testid="dirty">{dirty ? "dirty" : "clean"}</div>
      <div data-testid="cansave">{canSave ? "cansave" : "blocked"}</div>
      <ProtocolTab
        draft={draft}
        onDraftChange={(updater) => setDraft((prev) => updater(prev))}
        attention={attention}
      />
    </div>
  );
}

// A realistic saved host: non-empty clientCapabilities.extensions plus a
// populated mcpProfile — mirrors what a claude/mcpjam-style host persists.
function realisticHost(): HostConfigInputV2 {
  return emptyHostConfigInputV2({
    clientCapabilities: {
      extensions: {
        "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] },
      },
    },
    mcpProfile: {
      profileVersion: 1,
      apps: {
        sandbox: {
          csp: { restrictTo: { connectDomains: ["https://example.com"] } },
        },
      },
    },
  } as Partial<HostConfigInputV2>);
}

describe("ProtocolTab arms the Save gate on edit", () => {
  it("editing capabilities in the JSON marks the draft dirty (empty host)", async () => {
    const user = userEvent.setup();
    const initial = emptyHostConfigInputV2();
    render(<Harness initial={initial} />);

    expect(screen.getByTestId("dirty").textContent).toBe("clean");

    const textarea = screen.getByLabelText("json") as HTMLTextAreaElement;
    const edited = JSON.stringify(
      {
        capabilities: { sampling: {} },
        connectionDefaults: {
          requestTimeout: initial.connectionDefaults.requestTimeout,
        },
      },
      null,
      2,
    );
    await user.clear(textarea);
    await user.paste(edited);

    expect(screen.getByTestId("dirty").textContent).toBe("dirty");
  });

  it("with NO model set, a protocol edit still enables Save (production gate)", async () => {
    const user = userEvent.setup();
    // modelId defaults to "" — the reporter's "no model" host.
    const initial = emptyHostConfigInputV2();
    expect(initial.modelId).toBe("");
    render(<Harness initial={initial} />);

    expect(screen.getByTestId("cansave").textContent).toBe("blocked");

    const textarea = screen.getByLabelText("json") as HTMLTextAreaElement;
    const current = JSON.parse(textarea.value);
    current.capabilities = { ...(current.capabilities ?? {}), sampling: {} };
    await user.clear(textarea);
    await user.paste(JSON.stringify(current, null, 2));

    // The reporter says Save stayed blocked until they set a model. If the
    // production gate is sound, editing the protocol config alone must arm it.
    expect(screen.getByTestId("cansave").textContent).toBe("cansave");
  });

  it("editing capabilities on a realistic seeded host marks dirty", async () => {
    const user = userEvent.setup();
    const initial = realisticHost();
    render(<Harness initial={initial} />);

    expect(screen.getByTestId("dirty").textContent).toBe("clean");

    const textarea = screen.getByLabelText("json") as HTMLTextAreaElement;
    const current = JSON.parse(textarea.value);
    // Tweak a value inside the existing extensions capability.
    current.capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes = [
      "text/html",
      "image/png",
    ];
    await user.clear(textarea);
    await user.paste(JSON.stringify(current, null, 2));

    expect(screen.getByTestId("dirty").textContent).toBe("dirty");
  });

  it("selecting the latest protocol version marks dirty", async () => {
    const user = userEvent.setup();
    const initial = realisticHost();
    render(<Harness initial={initial} />);

    expect(screen.getByTestId("dirty").textContent).toBe("clean");

    // Radix Select: open then pick the latest option.
    await user.click(screen.getByRole("combobox", { name: "MCP protocol version" }));
    await user.click(screen.getByText(/Latest \(2026-07-28\)/i));

    expect(screen.getByTestId("dirty").textContent).toBe("dirty");
  });
});

describe("MCP profile extension object validation", () => {
  const extensions = {
    "mcpjam/plugin-local-form-files": { version: 1, serverIds: ["saved-server"] },
    "existing/extension": { keep: true },
  };
  function initialConfig() {
    const initial = realisticHost();
    initial.mcpProfile = {
      ...initial.mcpProfile,
      profileVersion: 1,
      initialize: { clientInfo: { name: "fixture", version: "1" }, supportedProtocolVersions: ["2025-11-25", "2026-07-28"] },
      extensions,
    };
    return initial;
  }
  it.each([null, [], false, "invalid"])("preserves the saved extensions when the JSON field is %j", (invalid) => {
    const initial = initialConfig();
    const parsed = { ...protocolToJson(initial), extensions: invalid };
    expect(applyJsonToDraft(parsed, initial)).toBeNull();
    render(<Harness initial={initial} />);
    fireEvent.change(screen.getByLabelText("json"), { target: { value: JSON.stringify(parsed) } });
    expect(screen.getByRole("alert").textContent).toContain("extensions must be a JSON object");
    expect(screen.getByTestId("dirty").textContent).toBe("clean");
    expect(initial.mcpProfile?.extensions).toEqual(extensions);
    fireEvent.change(screen.getByLabelText("json"), { target: { value: JSON.stringify(protocolToJson(initial)) } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("round-trips file extension settings without changing the other profile fields", () => {
    const initial = initialConfig();
    const nextExtensions = { ...extensions, "mcpjam/plugin-file-targets": { version: 1, targets: [] } };
    const next = applyJsonToDraft({ ...protocolToJson(initial), extensions: nextExtensions }, initial);
    expect(next?.mcpProfile).toEqual({ ...initial.mcpProfile, extensions: nextExtensions });
    expect(protocolToJson(next!).extensions).toEqual(nextExtensions);
    render(<Harness initial={initial} />);
    fireEvent.change(screen.getByLabelText("json"), { target: { value: JSON.stringify(protocolToJson(next!)) } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("cansave").textContent).toBe("cansave");
  });
});
