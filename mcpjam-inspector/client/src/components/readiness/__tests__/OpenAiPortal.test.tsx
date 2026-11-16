/**
 * The copy of ChatGPT's plugin page for a `chatgpt-plugin` submission: the
 * stored plugin to choose when none is saved, then the plugin's page with
 * its version selector, the read-only package details with where the package
 * keeps each, the skills, the MCPs tab, and MCPJam's results under the fields
 * they read.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorySubmissionSession } from "@/hooks/use-directory-submission";
import type { SubmissionView } from "@/lib/apis/directory-submissions-api";
import { OpenAiPortal } from "../OpenAiPortal";
import {
  finding,
  flow,
  PLUGIN,
  PLUGIN_DETAIL,
  runRow,
  session,
  VERSION,
  view,
} from "./openai-fixtures";

const plugins = vi.hoisted(() => ({
  list: undefined as unknown,
  detail: undefined as unknown,
  version: undefined as unknown,
  enabled: true as boolean | undefined,
}));
vi.mock("@/hooks/usePluginImportApi", () => ({
  useProjectPlugins: () => plugins.list,
  useProjectPlugin: (id: string | null) => (id ? plugins.detail : undefined),
  usePluginVersion: (id: string | null) => (id ? plugins.version : undefined),
}));
vi.mock("@/hooks/usePluginsEnabled", () => ({
  usePluginsEnabledState: () => plugins.enabled,
}));
// The drawer's reviewer path: no attempt yet, and no saved secrets.
vi.mock("@/lib/apis/reviewer-attempts-api", () => ({
  getLatestReviewerAttempt: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/hooks/use-is-member-actor", () => ({ useIsMemberActor: () => true }));
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({ canManageMembers: true, isLoading: false }),
}));
vi.mock("@/hooks/useProjectSecrets", () => ({
  useProjectSecrets: () => [],
  useCreateProjectSecret: () => vi.fn(),
  useUpdateProjectSecret: () => vi.fn(),
}));

const onClose = vi.fn();

function renderPage(
  submission: SubmissionView,
  overrides: Partial<DirectorySubmissionSession> = {},
) {
  const current = session(submission, overrides);
  render(
    <OpenAiPortal
      flow={flow}
      view={submission}
      session={current}
      projectId="proj_1"
      onClose={onClose}
    />,
  );
  return current;
}

const RESULTS = [
  finding("openai.submission.privacy-disclosure", "violated", {
    title: "The privacy policy covers the five required topics",
    remediation: "Say how long you keep data.",
  }),
  finding("openai.skills.frontmatter", "violated", {
    remediation: "Give review-results a description.",
    details: { skills: ["review-results"] },
  }),
  finding("openai.endpoint.https", "satisfied"),
];

describe("OpenAiPortal", () => {
  beforeEach(() => {
    onClose.mockReset();
    plugins.list = [PLUGIN];
    plugins.detail = PLUGIN_DETAIL;
    plugins.version = VERSION;
    plugins.enabled = true;
  });

  it("with no plugin chosen, saves the stored plugin chosen with its active version", async () => {
    const current = renderPage(
      view({ pluginId: undefined, pluginVersionId: undefined }, { values: {} }),
    );
    expect(screen.getByRole("heading", { name: "Plugins" })).toBeVisible();
    expect(
      screen.getByText(/Its version stands for the ZIP you upload\./),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(current.setPlugin).toHaveBeenCalledWith({
      pluginId: "plg_1",
      pluginVersionId: "ver_2",
    });
  });

  it("says where to add a plugin when the project has none", () => {
    plugins.list = [];
    renderPage(view({ pluginId: undefined, pluginVersionId: undefined }));
    expect(
      screen.getByText(
        "This project has no plugins. Add one on Connect, then choose it here.",
      ),
    ).toBeVisible();
  });

  it("asks for another plugin when the saved one was uninstalled", () => {
    plugins.list = [{ ...PLUGIN, pluginId: "plg_2" }];
    renderPage(view());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The plugin this rehearsal used is no longer in the project. Choose another.",
    );
    expect(screen.getByRole("button", { name: "Choose" })).toBeVisible();
  });

  it("shows why a plugin choice was not saved", () => {
    renderPage(view({ pluginId: undefined, pluginVersionId: undefined }), {
      pluginError: "The plugin was not saved. Offline. Choose it again.",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The plugin was not saved. Offline. Choose it again.",
    );
  });

  it("with a version chosen, copies the plugin page and saves another version", async () => {
    const current = renderPage(view());
    expect(
      screen.getByRole("heading", { level: 1, name: "Sample Plugin" }),
    ).toBeVisible();
    expect(screen.getByText("Checks sample servers")).toBeVisible();
    for (const chip of [
      "Configuration incomplete",
      "Not submitted",
      "Not published",
    ]) {
      expect(screen.getByText(chip)).toBeVisible();
    }
    expect(screen.getByRole("link", { name: /Submission guide/ })).toHaveAttribute(
      "href",
      flow.source.url,
    );
    // The reviewer and submit steps' missing answers list in the drawer and
    // the dialog, not on this tab.
    expect(screen.getByRole("tab", { name: "Metadata & Skills" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: "Upload new version" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Review information, has findings" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Submit for review" })).toBeEnabled();

    const version = screen.getByRole("combobox", { name: "Version" });
    expect(version).toHaveTextContent("1.0.1 · Draft");
    await userEvent.click(version);
    await userEvent.click(screen.getByRole("option", { name: "1.0.0 · Draft" }));
    expect(current.setPlugin).toHaveBeenCalledWith({
      pluginId: "plg_1",
      pluginVersionId: "ver_1",
    });

    await userEvent.click(screen.getByRole("button", { name: "Plugins" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows package details read only, with where the package keeps each", () => {
    renderPage(view({}, { findings: RESULTS }));
    expect(screen.queryByRole("textbox")).toBeNull();
    const developer = screen.getByText("Developer").parentElement;
    if (!developer) throw new Error("No Developer row");
    expect(within(developer).getByText("Sample Co")).toBeVisible();
    // The file and key the package keeps it under, the whole path on hover.
    expect(within(developer).getByText("plugin.json: developerName")).toHaveAttribute(
      "title",
      "plugin.json#/extensions/com.openai/interface/developerName",
    );
    const support = screen.getByText("Support").parentElement;
    if (!support) throw new Error("No Support row");
    expect(within(support).getByText("—")).toBeVisible();
    expect(
      screen.getByText(
        "Package details are read-only here; edit them in your source package.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/not imported into this rehearsal/)).toBeNull();

    // MCPJam's result for the privacy policy sits under that field.
    const privacy = screen.getByText("Privacy policy").parentElement;
    if (!privacy) throw new Error("No Privacy policy row");
    expect(
      within(privacy).getByText(
        "The privacy policy covers the five required topics",
      ),
    ).toBeVisible();
    expect(within(privacy).getByText("MCPJam")).toBeVisible();
  });

  it("says the package was not imported, and claims nothing it holds is missing", () => {
    renderPage(view({}, { values: {} }));
    expect(
      screen.getByText(
        "The package's values are not imported into this rehearsal. Run checks to grade the package itself.",
      ),
    ).toBeVisible();
    const panel = within(screen.getByRole("complementary", { name: "Findings" }));
    expect(panel.queryByText(/Developer name is required/)).toBeNull();
    expect(panel.queryByText("Login URL is required.")).toBeNull();
  });

  it("opens the Review information drawer and the Submit for review dialog from the toolbar", async () => {
    renderPage(
      view({}, {
        findings: [
          finding("openai.submission.geography", "violated", {
            remediation: "Declare the countries the plugin is offered in.",
          }),
        ],
      }),
    );
    // A reviewer result shows in the drawer, not in the tab's Findings.
    const panel = within(screen.getByRole("complementary", { name: "Findings" }));
    expect(panel.queryByText("Declare the countries the plugin is offered in.")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /^Review information/ }));
    const drawer = within(screen.getByRole("dialog", { name: "Review information" }));
    expect(drawer.getByRole("heading", { name: "2. Reviewer credentials" })).toBeVisible();
    // The reviewer step's missing answers, under their fields.
    expect(drawer.getByText("Error: Login URL is required.")).toBeVisible();
    expect(await drawer.findByRole("region", { name: "Reviewer path" })).toBeVisible();
    await userEvent.click(
      drawer.getByRole("button", { name: "Countries and translations, has findings" }),
    );
    expect(drawer.getByText("Declare the countries the plugin is offered in.")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    const dialog = within(screen.getByRole("dialog", { name: "Submit for review" }));
    expect(dialog.getAllByRole("checkbox")).toHaveLength(6);
    expect(dialog.getByRole("button", { name: "Mark as submitted" })).toBeDisabled();
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives each skill the last run's status", () => {
    renderPage(view({}, { findings: RESULTS }));
    const row = (name: string) => screen.getByRole("row", { name: new RegExp(name) });
    expect(within(row("run-checks")).getByText("Checks passed")).toBeVisible();
    expect(within(row("run-checks")).getByText("4 minutes ago")).toBeVisible();
    expect(
      within(row("review-results")).getByText("Needs attention"),
    ).toBeVisible();
  });

  it("reads the MCP configuration from the connection's checks", () => {
    const connected = [
      finding("openai.endpoint.https", "satisfied"),
      finding("openai.auth.challenge", "satisfied"),
      finding("openai.domain.challenge-served", "satisfied"),
    ];
    renderPage(view({}, { findings: connected }));
    expect(screen.getByText("Configured")).toBeVisible();
  });

  it("says when the results are another version's", () => {
    const submission = view({}, { findings: RESULTS });
    renderPage(submission, {
      run: { status: "done", run: runRow("run_1", submission, "ver_1") },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "These results are for another version. Run checks to grade this one.",
    );
    const row = screen.getByRole("row", { name: /run-checks/ });
    expect(within(row).getByText("Not checked")).toBeVisible();
  });

  it("puts the MCPs results on their own tab with their own Findings", async () => {
    renderPage(
      view(
        {},
        {
          findings: [
            ...RESULTS,
            finding("openai.tools.annotations", "violated", {
              remediation: "Declare readOnlyHint on every tool.",
            }),
          ],
        },
      ),
    );
    const listing = within(screen.getByRole("complementary", { name: "Findings" }));
    expect(listing.queryByText("Declare readOnlyHint on every tool.")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: /MCPs/ }));
    // The connect panel, with the key the version's mcp.json declares.
    expect(screen.getByRole("heading", { name: "Connect MCP server" })).toBeVisible();
    expect(screen.getAllByText("sample").length).toBeGreaterThan(0);
    const mcp = within(screen.getByRole("complementary", { name: "Findings" }));
    expect(mcp.getByText("Declare readOnlyHint on every tool.")).toBeVisible();
    expect(mcp.queryByText("Say how long you keep data.")).toBeNull();
  });
});
