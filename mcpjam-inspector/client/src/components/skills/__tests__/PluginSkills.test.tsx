/**
 * Plugin skills in the Skills tab: listed as their own source with a
 * "Plugin · <name>" badge, opened read-only with a way to the plugin's
 * Settings, and detachable as an editable copy (admins).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  installed: { value: undefined as unknown },
  version: { value: undefined as unknown },
  activeRows: { value: [] as unknown[] },
  skill: { value: undefined as unknown },
  canManage: true,
  detach: vi.fn(),
  navigate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/usePluginImportApi", () => ({
  useProjectPlugins: () => h.installed.value,
  usePluginVersion: (id: string | null) => (id ? h.version.value : undefined),
  useDetachPluginSkill: () => h.detach,
}));
vi.mock("@/hooks/useActivePlugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useActivePlugins")>()),
  useActivePlugins: () => ({
    plugins: h.activeRows.value,
    activePlugins: [],
    activeServers: [],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({
    canManageMembers: h.canManage,
    isLoading: false,
  }),
}));
vi.mock("@/hooks/use-soft-query", () => ({
  useSoftQuery: () => ({ data: h.skill.value, error: undefined }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/lib/app-navigation", () => ({
  buildProjectPluginPath: (id: string) => `/servers/plugins/${id}`,
  useAppNavigate: () => h.navigate,
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: h.toastSuccess, error: h.toastError },
}));
vi.mock("@/components/plugins/PluginSettingsSection", () => ({
  PluginSettingsSection: (props: { pluginId: string }) => (
    <div data-testid="plugin-settings-section">{props.pluginId}</div>
  ),
}));
vi.mock("../SkillFileViewer", () => ({
  SkillFileViewer: (props: { file: { content: string } | null }) => (
    <div data-testid="skill-file-viewer">{props.file?.content}</div>
  ),
}));

import { PluginSkillDetail, PluginSkillsSection } from "../PluginSkills";

const plugin = {
  pluginId: "pl_bits",
  projectId: "p_1",
  name: "bits-and-bolts",
  displayName: "Bits & Bolts",
  enabled: true,
  activeVersionId: "pv_1",
  createdAt: 1,
  updatedAt: 1,
};

const row = {
  pluginId: "pl_bits",
  pluginVersionId: "pv_1",
  name: "bits-and-bolts",
  displayName: "Bits & Bolts",
  status: "active",
  servers: [],
  skills: [
    {
      skillId: "sk_triage",
      modelRef: "bits-and-bolts/triage",
      name: "triage",
      description: "Sort incoming parts",
    },
  ],
};

const selection = {
  pluginId: "pl_bits",
  pluginLabel: "Bits & Bolts",
  skillId: "sk_triage",
  modelRef: "bits-and-bolts/triage",
  name: "triage",
  description: "Sort incoming parts",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.installed.value = [plugin];
  h.activeRows.value = [row];
  h.canManage = true;
  h.skill.value = { content: "# Triage\nSort parts." };
  h.version.value = {
    pluginVersionId: "pv_1",
    servers: [],
    skills: [
      {
        componentId: "c_triage",
        componentKey: "skill:triage",
        declaredName: "triage",
        modelRef: "bits-and-bolts/triage",
        materializedSkillId: "sk_triage",
      },
    ],
  };
  h.detach.mockResolvedValue({ skillId: "sk_copy" });
});

describe("PluginSkillsSection", () => {
  it("lists each plugin skill with its plugin's badge and opens it", () => {
    const onOpenSkill = vi.fn();
    const onCountChange = vi.fn();
    render(
      <PluginSkillsSection
        projectId="p_1"
        selectedSkillId={null}
        onOpenSkill={onOpenSkill}
        onCountChange={onCountChange}
      />,
    );
    const rowEl = screen.getByTestId("plugin-skill-row");
    expect(rowEl.textContent).toContain("triage");
    expect(rowEl.textContent).toContain("Plugin · Bits & Bolts");
    expect(onCountChange).toHaveBeenLastCalledWith(1);
    fireEvent.click(rowEl);
    expect(onOpenSkill).toHaveBeenCalledWith(selection);
  });

  it("opens a permalinked plugin's first skill once", () => {
    const onOpenSkill = vi.fn();
    const { rerender } = render(
      <PluginSkillsSection
        projectId="p_1"
        selectedSkillId={null}
        focusPluginId="pl_bits"
        onOpenSkill={onOpenSkill}
      />,
    );
    rerender(
      <PluginSkillsSection
        projectId="p_1"
        selectedSkillId="sk_triage"
        focusPluginId="pl_bits"
        onOpenSkill={onOpenSkill}
      />,
    );
    expect(onOpenSkill).toHaveBeenCalledTimes(1);
    expect(onOpenSkill).toHaveBeenCalledWith(selection);
  });

  it("falls back to the version's skills without an active-plugins answer", () => {
    h.activeRows.value = [];
    render(
      <PluginSkillsSection
        projectId="p_1"
        selectedSkillId={null}
        onOpenSkill={vi.fn()}
      />,
    );
    expect(screen.getByTestId("plugin-skill-row").textContent).toContain(
      "Plugin · Bits & Bolts",
    );
  });
});

describe("PluginSkillDetail", () => {
  it("shows the skill read-only with its plugin badge", () => {
    render(<PluginSkillDetail projectId="p_1" skill={selection} />);
    expect(screen.getByText("Plugin · Bits & Bolts")).toBeTruthy();
    expect(screen.getByText("bits-and-bolts/triage")).toBeTruthy();
    expect(screen.getByTestId("skill-file-viewer").textContent).toContain(
      "Sort parts.",
    );
    expect(screen.queryByTitle("Delete skill")).toBeNull();
    expect(screen.queryByTitle("Edit skill")).toBeNull();
  });

  it("keeps a skills-only plugin's Plugin section in the skill detail", () => {
    render(<PluginSkillDetail projectId="p_1" skill={selection} />);
    expect(screen.queryByTestId("plugin-settings-section")).toBeNull();
    fireEvent.click(screen.getByTestId("plugin-skill-open-plugin"));
    expect(screen.getByTestId("plugin-settings-section").textContent).toBe(
      "pl_bits",
    );
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("links to the plugin's server Settings when it has servers", () => {
    h.version.value = {
      ...(h.version.value as object),
      servers: [{ componentId: "c_1", materializedServerId: "s_cad" }],
    };
    render(<PluginSkillDetail projectId="p_1" skill={selection} />);
    fireEvent.click(screen.getByTestId("plugin-skill-open-plugin"));
    expect(h.navigate).toHaveBeenCalledWith("/servers/plugins/pl_bits");
  });

  it("detaches an editable copy under the chosen name", async () => {
    const onDetached = vi.fn();
    render(
      <PluginSkillDetail
        projectId="p_1"
        skill={selection}
        onDetached={onDetached}
      />,
    );
    fireEvent.click(screen.getByTestId("plugin-skill-detach"));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "triage-mine" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("plugin-skill-detach-confirm"));
    });
    expect(h.detach).toHaveBeenCalledWith("c_triage", "triage-mine");
    expect(onDetached).toHaveBeenCalled();
    expect(h.toastSuccess).toHaveBeenCalled();
  });

  it("gives a member Detach disabled, with the reason", () => {
    h.canManage = false;
    render(<PluginSkillDetail projectId="p_1" skill={selection} />);
    expect(
      (screen.getByTestId("plugin-skill-detach") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByTestId("plugin-skill-detach-wrapper").getAttribute("title"),
    ).toBe("Only project admins can detach plugin skills.");
  });
});
