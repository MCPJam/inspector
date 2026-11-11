import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayConnectionTestResult } from "@/shared/gateway-connection";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import { useSettingsDraft } from "../../../settings/SettingsDraftProvider";
import {
  ConfigureProviderSheet,
  type ConfigureSection,
} from "../ConfigureProviderSheet";
import type { GatewayTestRequest } from "../use-gateway-connection-test";

const testConnection = vi.hoisted(() =>
  vi.fn(
    async (
      _request: GatewayTestRequest,
    ): Promise<GatewayConnectionTestResult | { error: string }> => ({
      error: "unset",
    }),
  ),
);

vi.mock("../use-gateway-connection-test", () => ({
  useGatewayConnectionTest: () => testConnection,
}));

vi.mock("../../../settings/SettingsDraftProvider", () => ({
  useSettingsDraft: vi.fn(),
}));

/** Serves Chat Completions and Anthropic Messages; Responses failed its last Test. */
const SAVED: OrgModelProvider = {
  providerKey: "custom:litellm",
  displayName: "litellm",
  enabled: true,
  hasSecret: true,
  baseUrl: "https://litellm.acme.example/v1",
  runtimeLocation: "cloud",
  apis: ["chatCompletions", "anthropicMessages"],
  models: [
    { nativeModelId: "claude-sonnet-4.5", modelId: "anthropic/claude-sonnet-4.5", mappingSource: "name" },
    { nativeModelId: "smart", modelId: "openai/gpt-5.5", mappingSource: "gateway", capabilities: { vision: { status: "unsupported", source: "declared", observedAt: 2 } } },
    { nativeModelId: "team-llama-70b" },
  ],
  lastTest: {
    at: 1,
    origin: "backend",
    ok: false,
    message: "The provider has nothing at https://litellm.acme.example/v1/responses. Check the base URL and the APIs this connection serves.",
    apis: { chatCompletions: "ok", responses: "failed", anthropicMessages: "ok" },
  },
};

const PASSED: GatewayConnectionTestResult = {
  reachable: true,
  origin: "backend",
  status: 200,
  apis: {
    chatCompletions: { result: "ok", status: 200 },
    responses: { result: "ok", status: 200 },
    anthropicMessages: { result: "ok", status: 200 },
  },
  models: [{ nativeModelId: "claude-sonnet-4.5", suggestedModelId: "anthropic/claude-sonnet-4.5", suggestionSource: "name" }],
};

const onSave = vi.fn(async () => undefined);
const onOpenChange = vi.fn();

function sheet(
  provider: OrgModelProvider | null,
  { requireOrgKeys = false, initialSection }: { requireOrgKeys?: boolean; initialSection?: ConfigureSection } = {},
) {
  return (
    <ConfigureProviderSheet
      provider={provider}
      open
      onOpenChange={onOpenChange}
      organizationId="org_1"
      requireOrgKeys={requireOrgKeys}
      isSaving={false}
      onSave={onSave}
      initialSection={initialSection}
    />
  );
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const type = (id: string, value: string) =>
  fireEvent.change(field(id), { target: { value } });
const section = (title: string) =>
  screen.getByRole("button", { name: new RegExp(`^${title}`) });
const saveButton = () => screen.getByRole("button", { name: "Save changes" });

describe("ConfigureProviderSheet", () => {
  beforeEach(() => {
    testConnection.mockReset();
    onSave.mockClear();
    onOpenChange.mockClear();
  });

  it("shows the last Test and the model mapping, and each closed section's current value", () => {
    render(sheet(SAVED));
    expect(screen.getByRole("heading", { name: "litellm" })).toBeInTheDocument();
    expect(screen.getByText("Responses didn't answer the last test")).toBeInTheDocument();
    expect(screen.getByText("Until it answers, Codex and GitHub Copilot CLI can't use this provider.")).toBeInTheDocument();
    expect(screen.getByText("3 models · 1 not mapped")).toBeInTheDocument();
    expect(screen.getByText("Matched by name")).toBeInTheDocument();
    expect(screen.getByText("Reported by the provider")).toBeInTheDocument();
    expect(screen.getByText("Not mapped")).toBeInTheDocument();

    expect(section("Works with")).toHaveTextContent("3 features unavailable");
    expect(section("Works with")).toHaveAttribute("aria-expanded", "false");
    expect(section("Calls come from")).toHaveTextContent("MCPJam's servers");
    expect(section("APIs")).toHaveTextContent("2 APIs on · Responses didn't answer");
    expect(section("Capabilities")).toHaveTextContent("1 override");
    expect(section("Base URL and key")).toHaveTextContent("litellm.acme.example · key saved");
    expect(saveButton()).toBeDisabled();
  });

  it("says when the last Test passed, and when none was saved", () => {
    const view = render(sheet({ ...SAVED, lastTest: { at: 1, origin: "inspector", ok: true, apis: { chatCompletions: "ok" } } }));
    expect(screen.getByText("Last test passed.")).toBeInTheDocument();
    expect(screen.getByText("Tested from your Inspector.")).toBeInTheDocument();
    view.rerender(sheet({ ...SAVED, lastTest: undefined }));
    expect(screen.getByText("Not tested since it was saved.")).toBeInTheDocument();
  });

  it("opens on the section a row's badge names", () => {
    render(sheet(SAVED, { initialSection: "works-with" }));
    expect(section("Works with")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Needs Responses, which this provider doesn't serve.")).toHaveLength(2);
  });

  it("keeps the key policy's reason for an Inspector-run provider", () => {
    const local: OrgModelProvider = { ...SAVED, runtimeLocation: "local" };
    const view = render(sheet(local, { requireOrgKeys: true, initialSection: "works-with" }));
    expect(section("Calls come from")).toHaveTextContent("Each user's Inspector");
    expect(screen.getAllByText("Your organization's key policy doesn't allow calls from each user's Inspector.")).toHaveLength(2);
    view.rerender(sheet({ ...local }, { requireOrgKeys: false, initialSection: "works-with" }));
    expect(screen.getAllByText("Runs in each user's Inspector.")).toHaveLength(2);
  });

  it("saves the same payload the gateway editor sent, once something changed", async () => {
    render(sheet(SAVED, { initialSection: "calls" }));
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /Each user's Inspector/ }));
    expect(section("Calls come from")).toHaveTextContent("Each user's Inspector");

    await userEvent.click(screen.getByRole("button", { name: "Actions for smart" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Unmap" }));
    expect(screen.getByText("3 models · 2 not mapped")).toBeInTheDocument();

    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({
      providerKey: "custom:litellm",
      displayName: "litellm",
      baseUrl: "https://litellm.acme.example/v1",
      runtimeLocation: "local",
      apis: ["chatCompletions", "anthropicMessages"],
      models: [
        SAVED.models![0],
        { nativeModelId: "smart", capabilities: SAVED.models![1].capabilities },
        { nativeModelId: "team-llama-70b" },
      ],
    });
  });

  it("removes a model and adds one by name", async () => {
    render(sheet(SAVED));
    await userEvent.click(screen.getByRole("button", { name: "Actions for team-llama-70b" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove model" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Add a model" }), { target: { value: "house-model" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Add a model" }), { key: "Enter" });
    expect(screen.getByText("3 models · 1 not mapped")).toBeInTheDocument();
    expect(screen.queryByText("team-llama-70b")).not.toBeInTheDocument();
    expect(screen.getByText("house-model")).toBeInTheDocument();
  });

  it("requires the key again before saving a keyed provider with a new base URL", () => {
    render(sheet(SAVED, { initialSection: "connection" }));
    type("gateway-base-url", "https://gw.other.example/v1");
    expect(screen.getByText("Changing the base URL needs the API key again. Enter the key for gw.other.example.")).toBeInTheDocument();
    expect(section("Base URL and key")).toHaveTextContent("Enter the API key again");
    expect(saveButton()).toBeDisabled();

    type("gateway-secret", "sk-other");
    expect(screen.queryByText(/needs the API key again/)).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://gw.other.example/v1", secret: "sk-other" }),
    );
  });

  it("tests again with the saved key, and keeps the admin's mappings", async () => {
    testConnection.mockResolvedValue(PASSED);
    render(sheet(SAVED));
    fireEvent.click(screen.getByRole("button", { name: "Test again" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Connected. Found 3 models and 3 APIs.");
    expect(testConnection).toHaveBeenCalledWith({
      runtimeLocation: "cloud",
      baseUrl: "https://litellm.acme.example/v1",
      providerKey: "custom:litellm",
    });
    expect(section("APIs")).toHaveTextContent("3 APIs on");
    expect(section("Works with")).toHaveTextContent("OpenCode unavailable");
    expect(saveButton()).toBeEnabled();
  });

  it("asks for the key before testing a saved keyed provider from the Inspector", async () => {
    const lan: OrgModelProvider = { ...SAVED, providerKey: "custom:lan", baseUrl: "http://10.0.0.8:4000", runtimeLocation: "local" };
    render(sheet(lan));
    fireEvent.click(screen.getByRole("button", { name: "Test again" }));
    expect(await screen.findByText("Your Inspector can't use the saved key")).toBeInTheDocument();
    expect(testConnection).not.toHaveBeenCalled();
    expect(section("Base URL and key")).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(document.activeElement).toBe(field("gateway-secret")));

    testConnection.mockResolvedValueOnce({ ...PASSED, origin: "inspector" });
    type("gateway-secret", "sk-lan");
    fireEvent.click(screen.getByRole("button", { name: "Test again" }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(testConnection).toHaveBeenCalledWith({
      runtimeLocation: "local",
      baseUrl: "http://10.0.0.8:4000",
      secret: "sk-lan",
      providerKey: "custom:lan",
    });
  });

  it("switches calls to each user's Inspector and tests again when MCPJam's servers refuse a private address", async () => {
    const message = `Base URL points at "10.0.0.8", a private address MCPJam's servers can't call.`;
    testConnection.mockResolvedValueOnce({ reachable: false, origin: "backend", refusal: { code: "endpoint_private", message }, message, apis: {}, models: [] });
    testConnection.mockResolvedValueOnce({ ...PASSED, origin: "inspector" });
    render(sheet({ ...SAVED, hasSecret: false, baseUrl: "http://10.0.0.8:4000" }));
    fireEvent.click(screen.getByRole("button", { name: "Test again" }));
    fireEvent.click(await screen.findByRole("button", { name: "Make calls from each user's Inspector" }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(testConnection).toHaveBeenLastCalledWith({ runtimeLocation: "local", baseUrl: "http://10.0.0.8:4000", providerKey: "custom:litellm" });
    expect(section("Calls come from")).toHaveTextContent("Each user's Inspector");
  });

  it("ignores a Test answer that arrives after the panel moved to another provider", async () => {
    let answer: (result: GatewayConnectionTestResult) => void = () => {};
    testConnection.mockImplementation(
      () => new Promise((resolve) => { answer = resolve; }),
    );
    const view = render(sheet(SAVED));
    fireEvent.click(screen.getByRole("button", { name: "Test again" }));
    expect(testConnection).toHaveBeenCalledTimes(1);

    const other: OrgModelProvider = { ...SAVED, providerKey: "custom:other", displayName: "Other", baseUrl: "https://other.example/v1", models: [{ nativeModelId: "other-model" }], lastTest: undefined };
    view.rerender(sheet(other));
    await act(async () => answer(PASSED));

    expect(screen.getByRole("heading", { name: "Other" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("claude-sonnet-4.5")).not.toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("other-model")).toBeInTheDocument();
  });

  it("guards unsaved edits, and discarding closes the panel", () => {
    const guard = vi.mocked(useSettingsDraft);
    render(sheet(SAVED, { initialSection: "calls" }));
    expect(guard).toHaveBeenLastCalledWith(false, expect.any(Function), false);
    fireEvent.click(screen.getByRole("radio", { name: /Each user's Inspector/ }));
    expect(guard).toHaveBeenLastCalledWith(true, expect.any(Function), false);
    act(() => guard.mock.lastCall?.[1]());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
