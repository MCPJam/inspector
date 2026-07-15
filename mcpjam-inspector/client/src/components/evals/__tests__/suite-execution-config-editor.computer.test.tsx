import { render, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture the values the editor passes to Convex so we can assert the
// eval-suite sanitizer ran before any write.
const setSuiteConfig = vi.fn(async () => "host-config-id");
let suiteDto: unknown = null;
let projectDefaultDto: unknown = null;
let catalog: unknown = [];

vi.mock("convex/react", () => ({
  useQuery: (name: string) => {
    if (name === "hostConfigsV2:getSuiteConfig") return suiteDto;
    if (name === "hostConfigsV2:getProjectDefault") return projectDefaultDto;
    if (name === "builtInTools/catalog:listBuiltInTools") return catalog;
    return undefined;
  },
  useMutation: () => setSuiteConfig,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The reset handler is what we're testing; the editor body is irrelevant.
vi.mock("@/components/client-config/ClientConfigEditor", () => ({
  ClientConfigEditor: () => null,
}));

import { SuiteExecutionConfigEditor } from "../suite-execution-config-editor";

function projectDefaultWithComputer() {
  return {
    id: "host-default",
    schemaVersion: 2,
    hostStyle: "claude",
    modelId: "anthropic/claude-sonnet-4-6",
    systemPrompt: "",
    temperature: 0.7,
    requireToolApproval: false,
    serverIds: [],
    optionalServerIds: [],
    builtInToolIds: ["web_search", "bash"],
    // A project default may legitimately attach a computer (for chatbox
    // hosts). Resetting an eval suite to it must NOT carry the computer over.
    computer: { kind: "personal", workdir: "/srv" },
    connectionDefaults: { headers: {}, requestTimeout: 10000 },
    clientCapabilities: {},
    hostContext: {},
  };
}

afterEach(() => {
  vi.clearAllMocks();
  suiteDto = null;
  projectDefaultDto = null;
  catalog = [];
});

describe("SuiteExecutionConfigEditor — eval-suite computer sanitization", () => {
  it("reset to project default does NOT save a computer (or computer-backed ids) into the suite config", async () => {
    suiteDto = null; // no v2 row yet → empty seed
    projectDefaultDto = projectDefaultWithComputer();
    catalog = [
      {
        id: "web_search",
        displayLabel: "Web Search",
        description: "",
        category: "search",
        billable: true,
      },
      {
        id: "bash",
        displayLabel: "Bash",
        description: "",
        category: "code",
        billable: false,
        requiresComputer: true,
      },
    ];

    const { getByText } = render(
      <SuiteExecutionConfigEditor
        suite={{ _id: "suite-1" as never, defaultConfig: undefined }}
        availableModels={[]}
        projectId="project-1"
      />
    );

    fireEvent.click(getByText("Reset to project default"));

    await waitFor(() => expect(setSuiteConfig).toHaveBeenCalledTimes(1));
    const { input } = setSuiteConfig.mock.calls[0][0] as {
      input: { computer?: unknown; builtInToolIds: string[] };
    };
    // The whole point: the computer is gone, and the computer-backed `bash`
    // id was stripped — so the backend won't abort runs on this suite.
    expect(input.computer).toBeUndefined();
    expect(input.builtInToolIds).toEqual(["web_search"]);
  });
});
