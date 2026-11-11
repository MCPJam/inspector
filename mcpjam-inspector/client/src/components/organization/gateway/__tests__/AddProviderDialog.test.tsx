import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayConnectionTestResult } from "@/shared/gateway-connection";
import { useSettingsDraft } from "../../../settings/SettingsDraftProvider";
import { AddProviderDialog } from "../AddProviderDialog";
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

const MODELS: GatewayConnectionTestResult["models"] = [
  { nativeModelId: "claude-sonnet-4.5", suggestedModelId: "anthropic/claude-sonnet-4.5", suggestionSource: "name" },
  { nativeModelId: "house-model" },
];

const PASSED: GatewayConnectionTestResult = {
  reachable: true,
  origin: "backend",
  status: 200,
  apis: {
    chatCompletions: { result: "ok", status: 200 },
    responses: { result: "ok", status: 200 },
    anthropicMessages: { result: "ok", status: 200 },
    embeddings: { result: "untested" },
  },
  models: MODELS,
};

const PARTIAL: GatewayConnectionTestResult = {
  ...PASSED,
  apis: {
    ...PASSED.apis,
    responses: { result: "failed", status: 404, message: "The provider has nothing at https://litellm.acme.example/v1/responses. Check the base URL and the APIs this connection serves." },
  },
};

const onSave = vi.fn(async () => undefined);
const onOpenChange = vi.fn();

function renderDialog(open = true) {
  return render(
    <AddProviderDialog
      open={open}
      onOpenChange={onOpenChange}
      organizationId="org_1"
      existingProviderKeys={["custom:taken"]}
      isSaving={false}
      onSave={onSave}
    />,
  );
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const type = (id: string, value: string) =>
  fireEvent.change(field(id), { target: { value } });
const submitTest = () => fireEvent.submit(field("gateway-base-url").closest("form")!);
const addButton = () => screen.getByRole("button", { name: "Add provider" });

describe("AddProviderDialog", () => {
  beforeEach(() => {
    testConnection.mockReset();
    onSave.mockClear();
    onOpenChange.mockClear();
  });

  it("asks only for the URL and key, and a passing Test shows one line", async () => {
    testConnection.mockResolvedValue(PASSED);
    renderDialog();
    expect(addButton()).toBeDisabled();
    type("gateway-base-url", "https://litellm.acme.example/v1");
    type("gateway-secret", "sk-test");
    submitTest();

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Connected. Found 2 models and 3 APIs.",
    );
    expect(screen.getByText("litellm")).toBeInTheDocument();
    expect(testConnection).toHaveBeenCalledWith({
      runtimeLocation: "cloud",
      baseUrl: "https://litellm.acme.example/v1",
      secret: "sk-test",
    });
    expect(screen.queryByText("Works with")).not.toBeInTheDocument();
    expect(addButton()).toBeEnabled();
  });

  it("saves every default the Test produced, as the gateway editor did", async () => {
    testConnection.mockResolvedValue(PARTIAL);
    renderDialog();
    type("gateway-base-url", "https://litellm.acme.example/v1");
    type("gateway-secret", "sk-test");
    submitTest();

    expect(await screen.findByText("Responses didn't answer")).toBeInTheDocument();
    expect(screen.getByText("Tested from MCPJam's servers")).toBeInTheDocument();
    fireEvent.click(addButton());
    expect(onSave).toHaveBeenCalledWith({
      providerKey: "custom:litellm",
      displayName: "litellm",
      baseUrl: "https://litellm.acme.example/v1",
      runtimeLocation: "cloud",
      apis: ["chatCompletions", "anthropicMessages"],
      models: [
        { nativeModelId: "claude-sonnet-4.5", modelId: "anthropic/claude-sonnet-4.5", mappingSource: "name" },
        { nativeModelId: "house-model" },
      ],
      secret: "sk-test",
    });
  });

  it("moves focus to the key and quotes the provider when it rejects the key", async () => {
    const message = 'The provider rejected the API key: "Invalid proxy server token passed". Check the key and test again.';
    testConnection.mockResolvedValue({ ...PASSED, status: 401, message, apis: {}, models: [] });
    renderDialog();
    type("gateway-base-url", "https://litellm.acme.example");
    type("gateway-secret", "sk-wrong");
    submitTest();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText("The provider needs a valid API key. Update the key and test again.")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(field("gateway-secret")));
    expect(addButton()).toBeDisabled();
  });

  it("shows the guard's reason and re-tests from the Inspector when MCPJam's servers refuse a private address", async () => {
    const message = `Base URL points at "10.0.0.8", a private address MCPJam's servers can't call. List it in MCPJAM_PRIVATE_EGRESS_ALLOWLIST on a self-hosted install, or set the connection to run from each user's Inspector.`;
    testConnection.mockResolvedValueOnce({ reachable: false, origin: "backend", refusal: { code: "endpoint_private", message }, message, apis: {}, models: [] });
    testConnection.mockResolvedValueOnce({ ...PASSED, origin: "inspector" });
    renderDialog();
    type("gateway-base-url", "http://10.0.0.8:4000");
    submitTest();
    expect(await screen.findByText(message)).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(field("gateway-base-url")));
    expect(addButton()).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Make calls from each user's Inspector" }));
    expect(await screen.findByText(/with calls from each user's Inspector/)).toBeInTheDocument();
    expect(testConnection).toHaveBeenLastCalledWith({ runtimeLocation: "local", baseUrl: "http://10.0.0.8:4000" });
    fireEvent.click(addButton());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ providerKey: "custom:custom-provider", runtimeLocation: "local" }),
    );
  });

  it("refuses a name another provider uses, or one with slashes or colons", async () => {
    testConnection.mockResolvedValue({ ...PASSED });
    renderDialog();
    type("gateway-base-url", "https://taken.acme.example/v1");
    submitTest();
    // The name from the host is taken, so the name field shows on its own.
    expect(
      await screen.findByText('A custom provider named "taken" already exists. Choose another name.'),
    ).toBeInTheDocument();
    expect(addButton()).toBeDisabled();

    type("gateway-name", "team/llm");
    expect(screen.getByText("Use a name without slashes or colons.")).toBeInTheDocument();
    expect(addButton()).toBeDisabled();

    type("gateway-name", "Team LLM");
    expect(addButton()).toBeEnabled();
    fireEvent.click(addButton());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ providerKey: "custom:team-llm", displayName: "Team LLM" }),
    );
  });

  it("renames from the one-line summary", async () => {
    testConnection.mockResolvedValue(PASSED);
    renderDialog();
    type("gateway-base-url", "https://litellm.acme.example/v1");
    submitTest();
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    expect(field("gateway-name").value).toBe("litellm");
    type("gateway-name", "Taken");
    expect(screen.getByText('A custom provider named "Taken" already exists. Choose another name.')).toBeInTheDocument();
  });

  it("lets the admin name a model and its APIs when the Test listed none", async () => {
    testConnection.mockResolvedValue({
      reachable: true,
      origin: "backend",
      status: 200,
      message: "The provider listed no models. Add models to the provider, then test again.",
      apis: { chatCompletions: { result: "untested" }, responses: { result: "untested" } },
      models: [],
    });
    renderDialog();
    type("gateway-base-url", "https://empty.acme.example/v1");
    submitTest();
    expect(await screen.findByText("The provider listed no models. Name a model below, or add models to the provider and test again.")).toBeInTheDocument();
    expect(addButton()).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Add a model" }), { target: { value: "house-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("house-model")).toBeInTheDocument();
    expect(addButton()).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /Chat Completions/ }));
    expect(addButton()).toBeEnabled();
    fireEvent.click(addButton());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKey: "custom:empty",
        apis: ["chatCompletions"],
        models: [{ nativeModelId: "house-model" }],
      }),
    );
  });

  it("keeps a model and APIs the admin named when the same provider is tested again", async () => {
    testConnection.mockResolvedValue({
      reachable: true,
      origin: "backend",
      status: 200,
      message: "The provider listed no models. Add models to the provider, then test again.",
      apis: { chatCompletions: { result: "untested" }, responses: { result: "untested" } },
      models: [],
    });
    renderDialog();
    type("gateway-base-url", "https://empty.acme.example/v1");
    submitTest();
    await screen.findByText("The provider listed no models. Name a model below, or add models to the provider and test again.");
    fireEvent.change(screen.getByRole("textbox", { name: "Add a model" }), { target: { value: "house-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Chat Completions/ }));

    submitTest();
    await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(2));
    await screen.findByText("The provider listed no models. Name a model below, or add models to the provider and test again.");
    expect(screen.getByText("house-model")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Chat Completions/ })).toBeChecked();
    expect(addButton()).toBeEnabled();
  });

  it("ignores a Test answer that arrives after the dialog reopened", async () => {
    let answer: (result: GatewayConnectionTestResult) => void = () => {};
    testConnection.mockImplementation(
      () => new Promise((resolve) => { answer = resolve; }),
    );
    const view = renderDialog();
    type("gateway-base-url", "https://litellm.acme.example/v1");
    submitTest();
    expect(testConnection).toHaveBeenCalledTimes(1);

    view.rerender(
      <AddProviderDialog open={false} onOpenChange={onOpenChange} organizationId="org_1" existingProviderKeys={[]} isSaving={false} onSave={onSave} />,
    );
    view.rerender(
      <AddProviderDialog open onOpenChange={onOpenChange} organizationId="org_1" existingProviderKeys={[]} isSaving={false} onSave={onSave} />,
    );
    await act(async () => answer(PASSED));

    expect(field("gateway-base-url").value).toBe("");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();
  });

  it("drops a pending Test when the base URL changes, and lets a new one start", async () => {
    let answer: (result: GatewayConnectionTestResult) => void = () => {};
    testConnection.mockImplementationOnce(
      () => new Promise((resolve) => { answer = resolve; }),
    );
    renderDialog();
    type("gateway-base-url", "https://litellm.acme.example/v1");
    submitTest();
    expect(screen.getByRole("button", { name: "Testing..." })).toBeDisabled();

    type("gateway-base-url", "https://gw.other.example/v1");
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
    await act(async () => answer(PASSED));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();

    testConnection.mockResolvedValueOnce(PASSED);
    submitTest();
    expect(await screen.findByText("gw")).toBeInTheDocument();
    expect(testConnection).toHaveBeenLastCalledWith({
      runtimeLocation: "cloud",
      baseUrl: "https://gw.other.example/v1",
    });
  });

  it("drops a passing Test once the key changes, so the save matches what was tested", async () => {
    testConnection.mockResolvedValue(PASSED);
    renderDialog();
    type("gateway-base-url", "https://litellm.acme.example/v1");
    submitTest();
    await screen.findByRole("status");
    type("gateway-secret", "sk-other");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();
  });

  it("guards unsaved input, and discarding closes the dialog", () => {
    const guard = vi.mocked(useSettingsDraft);
    renderDialog();
    expect(guard).toHaveBeenLastCalledWith(false, expect.any(Function), false);
    type("gateway-base-url", "https://litellm.acme.example/v1");
    expect(guard).toHaveBeenLastCalledWith(true, expect.any(Function), false);
    act(() => guard.mock.lastCall?.[1]());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
