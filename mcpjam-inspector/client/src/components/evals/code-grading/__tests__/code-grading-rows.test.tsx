import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  initSuiteSettingsDraft,
  readSuiteSettingsValues,
  suiteSettingsReducer,
  toUpdateArgs,
} from "../../suite-settings-draft";
import type { EvalSuite } from "../../types";
import { codeGradingGate, type CodeGradingGate } from "../code-grading-flags";
import { GradingRow } from "../grading-row";
import { SetupCleanupRow } from "../setup-cleanup-row";

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  HOSTED_MODE: false,
}));

const ON = codeGradingGate(true, { enabled: true });
const OFF = codeGradingGate(false, undefined);

function suiteWith(patch: Partial<EvalSuite> = {}): EvalSuite {
  return {
    _id: "suite-1",
    createdBy: "u",
    name: "Invoices MCP",
    description: "",
    configRevision: "r",
    environment: { servers: [] },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

/** Both rows over one real draft, with the save's arguments on screen. */
function Sheet({
  suite,
  scriptsGate = ON,
  gradingGate = ON,
  runRefusal,
}: {
  suite: EvalSuite;
  scriptsGate?: CodeGradingGate;
  gradingGate?: CodeGradingGate;
  runRefusal?: string;
}) {
  const [draft, dispatch] = useReducer(suiteSettingsReducer, suite, (s) =>
    initSuiteSettingsDraft({
      suiteId: s._id,
      values: readSuiteSettingsValues(s),
    }),
  );
  return (
    <>
      <SetupCleanupRow
        suite={suite}
        draft={draft}
        dispatch={dispatch}
        gate={scriptsGate}
        runRefusal={runRefusal}
      />
      <GradingRow draft={draft} dispatch={dispatch} gate={gradingGate} />
      <pre data-testid="save-args">
        {JSON.stringify(toUpdateArgs(draft, suite._id))}
      </pre>
    </>
  );
}

function saveArgs(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId("save-args").textContent ?? "{}");
}

describe("Setup and cleanup, with its flag on", () => {
  it("adds a script and saves it through the draft", async () => {
    const user = userEvent.setup();
    render(<Sheet suite={suiteWith()} />);
    expect(screen.getAllByRole("button", { name: /^Add script/ })).toHaveLength(
      4,
    );
    await user.click(
      screen.getByRole("button", { name: "Add script: Before the run" }),
    );
    // The field Add script opens takes focus, ready to type into.
    expect(
      screen.getByRole("textbox", { name: "Before the run script" }),
    ).toHaveFocus();
    await user.type(
      screen.getByRole("textbox", { name: "Before the run script" }),
      "curl -fsS https://invoices.example.com/test/seed",
    );
    expect(saveArgs()).toEqual({
      suiteId: "suite-1",
      scripts: { runSetup: "curl -fsS https://invoices.example.com/test/seed" },
    });
  });

  it("keeps an emptied slot open, and an added-then-removed one leaves nothing to save", async () => {
    const user = userEvent.setup();
    render(<Sheet suite={suiteWith()} />);
    await user.click(
      screen.getByRole("button", { name: "Add script: After the run" }),
    );
    const field = screen.getByRole("textbox", { name: "After the run script" });
    await user.type(field, "x");
    await user.clear(field);
    expect(screen.getByRole("textbox", { name: "After the run script" })).toBe(
      field,
    );
    await user.click(
      screen.getByRole("button", { name: "Remove the After the run script" }),
    );
    expect(
      screen.queryByRole("textbox", { name: "After the run script" }),
    ).toBeNull();
    expect(saveArgs()).toEqual({ suiteId: "suite-1" });
  });

  it("sends every script whenever one changes, since the object is replaced", async () => {
    const user = userEvent.setup();
    render(
      <Sheet
        suite={suiteWith({
          scripts: { runSetup: "seed", iterationCleanup: "rm -rf out" },
        })}
      />,
    );
    await user.type(
      screen.getByRole("textbox", { name: "Before the run script" }),
      " --fast",
    );
    expect(saveArgs().scripts).toEqual({
      runSetup: "seed --fast",
      iterationCleanup: "rm -rf out",
    });
    await user.click(
      screen.getByRole("button", { name: "Remove the Before the run script" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Remove the After each iteration script",
      }),
    );
    expect(saveArgs().scripts).toBeNull();
  });

  it("draws scripts in code type with ligatures off, and flags one over 64 KB", () => {
    render(
      <Sheet
        suite={suiteWith({ scripts: { runSetup: "a".repeat(70_000) } })}
      />,
    );
    const field = screen.getByRole("textbox", {
      name: "Before the run script",
    });
    expect(field.className).toContain("font-code");
    expect(field.className).toContain("[font-variant-ligatures:none]");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This script is 69 KB. A script can be at most 64 KB.",
    );
  });

  it("says why Run is off and links to MCPJam when this inspector can't run them", () => {
    render(
      <Sheet
        suite={suiteWith({ scripts: { runSetup: "seed" } })}
        runRefusal="This suite has setup and cleanup scripts, but this inspector can't run MCPJam cloud sandboxes."
      />,
    );
    const notice = screen.getByTestId("suite-scripts-cloud-unreachable");
    expect(notice).toHaveTextContent("can't run MCPJam cloud sandboxes");
    expect(
      screen.getByRole("link", { name: "Open on MCPJam" }),
    ).toHaveAttribute("href", expect.stringContaining("suite-1"));
  });
});

describe("Setup and cleanup, with its flag off", () => {
  it("shows stored scripts read-only and can still clear them", async () => {
    const user = userEvent.setup();
    render(
      <Sheet
        suite={suiteWith({ scripts: { iterationSetup: "reset-db" } })}
        scriptsGate={OFF}
      />,
    );
    const field = screen.getByRole("textbox", {
      name: "Before each iteration script",
    });
    expect(field).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: /^Add script/ })).toBeNull();
    expect(
      screen.getByText(
        "Not enabled for this organization. These scripts still run, and you can remove them.",
      ),
    ).toBeInTheDocument();
    await user.type(field, "more");
    expect(saveArgs()).toEqual({ suiteId: "suite-1" });
    await user.click(
      screen.getByRole("button", {
        name: "Remove the Before each iteration script",
      }),
    );
    expect(saveArgs()).toEqual({ suiteId: "suite-1", scripts: null });
    // Removed, the row stays so the change can be saved or discarded.
    expect(
      document.querySelector('[data-setting-key="scripts"]'),
    ).not.toBeNull();
  });

  it("has no row when the suite holds no scripts", () => {
    render(<Sheet suite={suiteWith()} scriptsGate={OFF} gradingGate={OFF} />);
    expect(document.querySelector('[data-setting-key="scripts"]')).toBeNull();
    expect(document.querySelector('[data-setting-key="grading"]')).toBeNull();
  });

  it("explains a capability refusal to someone who has the flag", () => {
    render(
      <Sheet
        suite={suiteWith()}
        scriptsGate={codeGradingGate(true, {
          enabled: false,
          reason: "flag_false",
        })}
      />,
    );
    expect(
      screen.getByText("Not enabled for this organization."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Add script/ })).toBeNull();
  });
});

describe("Grading", () => {
  it("saves declared files and the network through the draft", async () => {
    const user = userEvent.setup();
    render(<Sheet suite={suiteWith()} />);
    const files = screen.getByRole("textbox", { name: "Files to copy" });
    await user.type(
      files,
      "/home/user/app/report.json{Enter}/home/user/app/out ",
    );
    await user.click(screen.getByRole("switch", { name: "Network" }));
    expect(
      screen.getByText("Evaluators can reach the web."),
    ).toBeInTheDocument();
    expect(saveArgs().grading).toEqual({
      files: ["/home/user/app/report.json", "/home/user/app/out"],
      network: "web",
    });
  });

  it("hints at a path the platform would refuse", async () => {
    const user = userEvent.setup();
    render(<Sheet suite={suiteWith()} />);
    const files = screen.getByRole("textbox", { name: "Files to copy" });
    await user.type(files, "/etc/passwd");
    expect(files).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "/etc/passwd must start with /home/user/.",
    );
  });

  it("reads off by default", () => {
    render(<Sheet suite={suiteWith()} />);
    expect(screen.getByRole("switch", { name: "Network" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(
      screen.getByText("Evaluators can't reach the network."),
    ).toBeInTheDocument();
  });

  it("with its flag off, shows stored settings read-only and can still clear them", async () => {
    const user = userEvent.setup();
    render(
      <Sheet
        suite={suiteWith({
          grading: { files: ["/home/user/app/report.json"], network: "web" },
        })}
        gradingGate={OFF}
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Files to copy" }),
    ).toHaveAttribute("readonly");
    const network = screen.getByRole("switch", { name: "Network" });
    await user.click(network);
    expect(network).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Remove the files to copy" }),
    );
    expect(saveArgs()).toEqual({ suiteId: "suite-1", grading: null });
  });
});
