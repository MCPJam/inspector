/**
 * Connect → Add plugin dialog (INS-2).
 *
 * The three acceptance criteria are covered directly: nothing is called
 * installed before the import row reaches `completed`, a retry resumes an
 * existing `preview_ready` import instead of re-uploading, and unsupported
 * components are visible and never described as executable.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginImportPreview } from "@/lib/plugins/plugin-api-types";

const h = vi.hoisted(() => ({
  row: { value: undefined as unknown },
  setupStatus: { value: undefined as unknown },
  startImport: vi.fn(),
  inspectImport: vi.fn(),
  commitImport: vi.fn(),
  track: vi.fn(),
  parseZip: vi.fn(),
}));

vi.mock("@/hooks/usePluginImportApi", () => ({
  usePluginImport: () => h.row.value,
  usePluginSetupStatus: () => h.setupStatus.value,
  usePluginImportActions: () => ({
    startImport: h.startImport,
    inspectImport: h.inspectImport,
    commitImport: h.commitImport,
    generateBundleUploadUrl: vi.fn(),
    createImport: vi.fn(),
  }),
}));
vi.mock("@/lib/analytics", () => ({ track: h.track }));
vi.mock("@/lib/plugins/folder-bundle", () => ({
  parsePluginBundleFromZip: h.parseZip,
  folderSelectionToPluginZip: vi.fn(),
  readSelectedFileBytes: async () => new Uint8Array([1, 2, 3]),
}));

import { AddPluginModal } from "../AddPluginModal";

const preview: PluginImportPreview = {
  identity: { name: "demo", displayName: "Demo", version: "1.0.0" },
  bundleHash: "aa11bb22cc33dd44",
  manifestHash: "ff00",
  counts: {
    skills: 1,
    servers: 1,
    apps: 0,
    assets: 0,
    unsupported: 1,
    warnings: 0,
  },
  skills: [
    {
      modelRef: "demo/triage",
      name: "triage",
      description: "Triage",
      supportingFileCount: 0,
      mcpToolDependencyCount: 0,
      hasOpenaiMetadata: false,
    },
  ],
  servers: [{ key: "api", transport: "http" }],
  apps: [],
  assets: [],
  setupRequirements: [],
  unsupported: [
    {
      kind: "hook",
      key: "postinstall",
      reason: "hooks are never executed",
      pathCount: 1,
    },
  ],
  warnings: [],
};

function importRow(overrides: Record<string, unknown>) {
  return {
    importId: "imp_1",
    projectId: "p_1",
    status: "preview_ready",
    preview,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
    ...overrides,
  };
}

/** Pick a ZIP and reach the preview phase. */
async function reachPreview() {
  const view = render(
    <AddPluginModal isOpen onClose={vi.fn()} projectId="p_1" />,
  );
  const file = new File([new Uint8Array([1, 2, 3])], "demo.zip", {
    type: "application/zip",
  });
  const input = document.querySelector(
    'input[type="file"][accept*="zip"]',
  ) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  await screen.findByTestId("add-plugin-selected-source");
  await act(async () => {
    fireEvent.click(screen.getByTestId("add-plugin-continue"));
  });
  h.row.value = importRow({});
  view.rerender(<AddPluginModal isOpen onClose={vi.fn()} projectId="p_1" />);
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.row.value = undefined;
  h.setupStatus.value = undefined;
  h.parseZip.mockResolvedValue({ bundleHash: "aa11bb22cc33dd44", warnings: [] });
  h.startImport.mockResolvedValue({
    importId: "imp_1",
    inspect: { importId: "imp_1", status: "preview_ready" },
  });
  h.commitImport.mockResolvedValue({
    importId: "imp_1",
    status: "completed",
    pluginVersionId: "pv_1",
  });
});

describe("AddPluginModal — install is gated on version finalize", () => {
  it("shows the preview without claiming the plugin is installed", async () => {
    await reachPreview();
    expect(screen.getByTestId("plugin-import-preview")).toBeTruthy();
    expect(screen.queryByTestId("add-plugin-installed")).toBeNull();
  });

  it("still does not say installed while the row is committing", async () => {
    const view = await reachPreview();
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-plugin-install-connect"));
    });
    // The commit action already resolved "completed", but the ROW is the
    // authority and it has not finalized yet.
    h.row.value = importRow({ status: "committing" });
    view.rerender(<AddPluginModal isOpen onClose={vi.fn()} projectId="p_1" />);
    expect(screen.queryByTestId("add-plugin-installed")).toBeNull();

    h.row.value = importRow({
      status: "completed",
      pluginId: "pl_1",
      pluginVersionId: "pv_1",
    });
    view.rerender(<AddPluginModal isOpen onClose={vi.fn()} projectId="p_1" />);
    expect(screen.getByTestId("add-plugin-installed")).toBeTruthy();
    expect(screen.getByText("Plugin installed")).toBeTruthy();
  });

  it("install-only commits with setActive false", async () => {
    await reachPreview();
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-plugin-install-only"));
    });
    expect(h.commitImport).toHaveBeenCalledWith("imp_1", { setActive: false });
  });

  it("install-and-connect commits with setActive true", async () => {
    await reachPreview();
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-plugin-install-connect"));
    });
    expect(h.commitImport).toHaveBeenCalledWith("imp_1", { setActive: true });
  });
});

describe("AddPluginModal — content-addressed re-import", () => {
  it("reports a reused version as already imported, not a fresh install", async () => {
    h.commitImport.mockResolvedValue({
      importId: "imp_1",
      status: "completed",
      pluginVersionId: "pv_1",
      reused: true,
    });
    const view = await reachPreview();
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-plugin-install-connect"));
    });
    h.row.value = importRow({
      status: "completed",
      pluginId: "pl_1",
      pluginVersionId: "pv_1",
    });
    view.rerender(<AddPluginModal isOpen onClose={vi.fn()} projectId="p_1" />);
    expect(screen.getByText("Already imported")).toBeTruthy();
    expect(screen.queryByText("Plugin installed")).toBeNull();
  });
});

describe("AddPluginModal — retry resumes", () => {
  it("retries the commit against the existing preview-ready import", async () => {
    h.commitImport.mockRejectedValueOnce(new Error("network blip"));
    await reachPreview();
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-plugin-install-connect"));
    });
    await screen.findByTestId("add-plugin-failure");

    h.startImport.mockClear();
    h.commitImport.mockResolvedValue({
      importId: "imp_1",
      status: "completed",
      pluginVersionId: "pv_1",
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-plugin-retry"));
    });
    // Resumed from the SAME import: no second upload.
    expect(h.startImport).not.toHaveBeenCalled();
    expect(h.commitImport).toHaveBeenLastCalledWith("imp_1", {
      setActive: true,
    });
  });

  it("resumes inspection for an import that never got inspected", async () => {
    h.startImport.mockResolvedValue({
      importId: "imp_1",
      inspect: { importId: "imp_1", status: "failed", failureCode: "TIMEOUT" },
    });
    const view = render(
      <AddPluginModal isOpen onClose={vi.fn()} projectId="p_1" />,
    );
    const file = new File([new Uint8Array([1])], "demo.zip");
    const input = document.querySelector(
      'input[type="file"][accept*="zip"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await screen.findByTestId("add-plugin-selected-source");
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-plugin-continue"));
    });
    h.row.value = importRow({ status: "uploaded", preview: undefined });
    view.rerender(<AddPluginModal isOpen onClose={vi.fn()} projectId="p_1" />);

    h.inspectImport.mockResolvedValue({
      importId: "imp_1",
      status: "preview_ready",
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-plugin-retry"));
    });
    expect(h.inspectImport).toHaveBeenCalledWith("imp_1");
  });
});

describe("AddPluginModal — validation and unsupported components", () => {
  it("lists every parser issue when preflight rejects the bundle", async () => {
    const { PluginBundleError } = await import("@mcpjam/sdk/plugin-bundle");
    h.parseZip.mockRejectedValue(
      new PluginBundleError([
        {
          code: "PATH_TRAVERSAL",
          severity: "error",
          message: "entry escapes the bundle root",
          path: "../evil",
        },
        {
          code: "MANIFEST_UNKNOWN_FIELD",
          severity: "warning",
          message: "unknown field",
        },
      ]),
    );
    render(<AddPluginModal isOpen onClose={vi.fn()} projectId="p_1" />);
    const input = document.querySelector(
      'input[type="file"][accept*="zip"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File([new Uint8Array([1])], "bad.zip")] },
      });
    });
    const panel = await screen.findByTestId("add-plugin-failure");
    expect(panel.textContent).toContain("PATH_TRAVERSAL");
    expect(panel.textContent).toContain("MANIFEST_UNKNOWN_FIELD");
    // Nothing was uploaded — preflight rejected before minting an upload URL.
    expect(h.startImport).not.toHaveBeenCalled();
  });

  it("shows unsupported components as preserved, never as executable", async () => {
    await reachPreview();
    const block = screen.getByTestId("plugin-preview-unsupported");
    expect(block.textContent).toContain("Lifecycle hooks");
    expect(block.textContent).toMatch(/does not run/i);
  });
});

describe("AddPluginModal — local mode", () => {
  it("explains that import needs a synced project instead of offering a picker", async () => {
    render(<AddPluginModal isOpen onClose={vi.fn()} projectId={null} />);
    await waitFor(() =>
      expect(screen.getByTestId("add-plugin-no-project")).toBeTruthy(),
    );
    expect(screen.queryByTestId("add-plugin-choose-zip")).toBeNull();
  });
});
