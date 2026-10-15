import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * A web search the organization's AI key policy refused shows why on the card
 * itself, worded for whoever reads it: an admin gets the way to AI providers,
 * a member reads why search is off, a share-link visitor one neutral
 * sentence. Any other tool, or a search that ran, shows nothing new.
 *
 * Mock stack mirrors tool-part-run-location.test.tsx, with the tool name
 * `web_search`.
 */

vi.mock("lucide-react", () => {
  const s = (props: any) => <div {...props} />;
  return {
    Box: s,
    Check: s,
    ChevronDown: s,
    Database: s,
    Loader2: s,
    Maximize2: s,
    MessageCircle: s,
    Pencil: s,
    PictureInPicture2: s,
    Play: s,
    RotateCcw: s,
    Shield: s,
    ShieldCheck: s,
    ShieldX: s,
    Terminal: s,
    X: s,
  };
});

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) => selector({ themeMode: "light" }),
}));

vi.mock("@/stores/widget-debug-store", () => ({
  useWidgetDebugStore: (selector: any) => selector({ widgets: new Map() }),
}));

const toolNameState = vi.hoisted(() => ({ name: "web_search" }));
// Dark-launch flag: the pill is part of the local-engine rollout. ON by
// default so the pill rows test the pill; the flag-off row flips it.
const flagState = vi.hoisted(() => ({ localComputerEnabled: true }));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useLocalComputerEnabled: () => flagState.localComputerEnabled,
}));
// `importOriginal` rather than a bare factory: this module re-exports the
// package's graph-free `@mcpjam/chat-ui/thread-helpers` subpath, and the parts
// this file does not care about (notably `readTraceDisplayText`, which decides
// whether a readable tool result is shown at all) have to behave like the real
// thing rather than be re-stubbed in every test file that shadows one helper.
vi.mock("../../thread-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../thread-helpers")>()),
  getToolNameFromType: () => toolNameState.name,
  getToolStateMeta: () => ({
    Icon: (props: any) => <div data-testid="status-icon" {...props} />,
    className: "",
  }),
  safeStringify: (v: any) => JSON.stringify(v),
  isDynamicTool: () => false,
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  UIType: { MCP_APPS: "mcp-apps", OPENAI_SDK: "openai-apps" },
}));

vi.mock("@mcpjam/design-system/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <span>{children}</span>,
}));

vi.mock("@mcpjam/design-system/badge", () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock("../../sandbox-debug-panel", () => ({
  SandboxDebugPanel: () => null,
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({ value }: any) => (
    <pre data-testid="json-editor">{JSON.stringify(value)}</pre>
  ),
}));

vi.mock("../text-part", () => ({
  TextPart: ({ text }: { text: string }) => (
    <div data-testid="text-part">{text}</div>
  ),
}));

import { ToolPart } from "../tool-part";
import {
  OrgAiRefusalHandoffProvider,
  orgAiRefusalHandoff,
} from "@/contexts/org-ai-refusal-context";

const refused = {
  error:
    "Web search is off for this organization. It requires its own AI provider keys, and web search can't run on them yet.",
  code: "org_runtime_unsupported",
  remediation: "unsupported",
};

const part = (output: unknown) =>
  ({
    type: "tool-invocation",
    toolName: "web_search",
    toolCallId: "call-1",
    state: "output-available",
    input: { query: "latest MCP spec" },
    output,
  }) as any;

function renderSearch(
  output: unknown,
  handoff?: Parameters<typeof orgAiRefusalHandoff>[0],
) {
  const card = <ToolPart part={part(output)} uiType="mcp-apps" />;
  return render(
    handoff ? (
      <OrgAiRefusalHandoffProvider value={orgAiRefusalHandoff(handoff)}>
        {card}
      </OrgAiRefusalHandoffProvider>
    ) : (
      card
    ),
  );
}

describe("ToolPart web search refusal", () => {
  it("offers an admin the way to AI providers", () => {
    const onManageOrgProviders = vi.fn();
    renderSearch(refused, { onManageOrgProviders });
    const notice = screen.getByTestId("web-search-refusal");
    expect(notice).toHaveAttribute(
      "data-refusal-code",
      "org_runtime_unsupported",
    );
    expect(notice).toHaveTextContent("Web search is off");
    fireEvent.click(
      screen.getByRole("button", { name: "Manage AI providers" }),
    );
    expect(onManageOrgProviders).toHaveBeenCalledTimes(1);
  });

  it("tells a member why, with no action they can't take", () => {
    renderSearch(refused, {});
    const notice = screen.getByTestId("web-search-refusal");
    expect(notice).toHaveTextContent(
      "Web search can't run on this organization's providers yet. Keep “Use your keys for all AI features” on and continue without Web Search.",
    );
    expect(
      screen.queryByRole("button", { name: "Manage AI providers" }),
    ).not.toBeInTheDocument();
  });

  it("reads as a member with no provider around it (eval and swarm transcripts)", () => {
    renderSearch(refused);
    expect(screen.getByTestId("web-search-refusal")).toHaveTextContent(
      "Keep “Use your keys for all AI features” on",
    );
  });

  it("asks a member to go to an admin when an admin can fix it", () => {
    renderSearch({ ...refused, code: "org_model_unconfigured" }, {});
    expect(screen.getByTestId("web-search-refusal")).toHaveTextContent(
      "Ask an organization admin",
    );
  });

  it("gives a visitor one sentence and no organization detail", () => {
    renderSearch(refused, {
      visitor: true,
      onManageOrgProviders: vi.fn(),
    });
    const notice = screen.getByTestId("web-search-refusal");
    expect(notice).toHaveTextContent(
      "Web search isn't available in this chat.",
    );
    expect(notice).not.toHaveTextContent("organization");
    expect(
      screen.queryByRole("button", { name: "Manage AI providers" }),
    ).not.toBeInTheDocument();
  });

  it("shows nothing for a search that ran or failed for another reason", () => {
    renderSearch({ results: [] }, { onManageOrgProviders: vi.fn() });
    expect(screen.queryByTestId("web-search-refusal")).not.toBeInTheDocument();
    renderSearch(
      { error: "Web search failed (500)." },
      { onManageOrgProviders: vi.fn() },
    );
    expect(screen.queryByTestId("web-search-refusal")).not.toBeInTheDocument();
  });

  it("shows nothing for another tool carrying the same code", () => {
    toolNameState.name = "bash";
    try {
      renderSearch(refused, { onManageOrgProviders: vi.fn() });
      expect(
        screen.queryByTestId("web-search-refusal"),
      ).not.toBeInTheDocument();
    } finally {
      toolNameState.name = "web_search";
    }
  });
});
