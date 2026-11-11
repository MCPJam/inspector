import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayConnectionTestResult } from "@/shared/gateway-connection";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import { GatewayDialog } from "../GatewayDialog";
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

const PASSED: GatewayConnectionTestResult = {
  reachable: true,
  origin: "backend",
  status: 200,
  apis: {
    chatCompletions: { result: "ok", status: 200 },
    responses: { result: "failed", status: 404, message: "The provider has nothing at https://litellm.acme.example/v1/responses. Check the base URL and the APIs this connection serves." },
    anthropicMessages: { result: "ok", status: 200 },
    embeddings: { result: "untested" },
  },
  models: [
    { nativeModelId: "claude-sonnet-4.5", suggestedModelId: "anthropic/claude-sonnet-4.5", suggestionSource: "name" },
    { nativeModelId: "house-model" },
  ],
};

const onSave = vi.fn(async () => undefined);

function renderDialog(editProvider: OrgModelProvider | null = null) {
  return render(
    <GatewayDialog
      open
      onOpenChange={vi.fn()}
      organizationId="org_1"
      editProvider={editProvider}
      existingProviderKeys={["custom:taken"]}
      requireOrgKeys={false}
      isSaving={false}
      onSave={onSave}
      onCancel={vi.fn()}
    />,
  );
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const type = (id: string, value: string) =>
  fireEvent.change(field(id), { target: { value } });
const submitTest = () => fireEvent.submit(field("gateway-base-url").closest("form")!);

describe("GatewayDialog", () => {
  beforeEach(() => {
    testConnection.mockReset();
    onSave.mockClear();
  });

  it("asks only for the URL and key, and Enter fills in the rest from the test", async () => {
    testConnection.mockResolvedValue(PASSED);
    renderDialog();
    expect(screen.queryByText("Works with")).not.toBeInTheDocument();
    type("gateway-base-url", "https://litellm.acme.example/v1");
    type("gateway-secret", "sk-test");
    submitTest();

    expect(await screen.findByText("Responses didn't answer")).toBeInTheDocument();
    expect(testConnection).toHaveBeenCalledWith({
      runtimeLocation: "cloud",
      baseUrl: "https://litellm.acme.example/v1",
      secret: "sk-test",
    });
    expect(screen.getByText("Tested from MCPJam's servers")).toBeInTheDocument();
    expect(field("gateway-name").value).toBe("litellm");
    expect(screen.getByRole("radio", { name: /MCPJam's servers/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Chat Completions/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^Responses/ })).not.toBeChecked();
    expect(screen.getByText("Matched by name")).toBeInTheDocument();
    expect(screen.getAllByText("Needs Responses, which this provider doesn't serve.")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
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

  it("moves focus to the key and quotes the gateway when it rejects the key", async () => {
    const message = 'The provider rejected the API key: "Invalid proxy server token passed". Check the key and test again.';
    testConnection.mockResolvedValue({ ...PASSED, status: 401, message, apis: {}, models: [] });
    renderDialog();
    type("gateway-base-url", "https://litellm.acme.example");
    type("gateway-secret", "sk-wrong");
    submitTest();
    expect(await screen.findByText(message)).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(field("gateway-secret")));
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

    fireEvent.click(screen.getByRole("button", { name: "Make calls from each user's Inspector" }));
    expect(await screen.findByText("Tested from your Inspector")).toBeInTheDocument();
    expect(testConnection).toHaveBeenLastCalledWith({ runtimeLocation: "local", baseUrl: "http://10.0.0.8:4000" });
    expect(screen.getByRole("radio", { name: /Each user's Inspector/ })).toBeChecked();
  });

  it("requires the key again before saving a keyed connection with a new base URL", () => {
    renderDialog({
      providerKey: "custom:litellm",
      displayName: "litellm",
      enabled: true,
      hasSecret: true,
      baseUrl: "https://litellm.acme.example/v1",
      runtimeLocation: "cloud",
      apis: ["chatCompletions"],
      models: [{ nativeModelId: "claude-sonnet-4.5", modelId: "anthropic/claude-sonnet-4.5", mappingSource: "admin" }],
    });
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeEnabled();
    expect(screen.getByText("Set by admin")).toBeInTheDocument();

    type("gateway-base-url", "https://gw.other.example/v1");
    expect(screen.getByText("Changing the base URL needs the API key again. Enter the key for gw.other.example.")).toBeInTheDocument();
    expect(save).toBeDisabled();

    type("gateway-secret", "sk-other");
    expect(screen.queryByText(/needs the API key again/)).not.toBeInTheDocument();
    expect(save).toBeEnabled();
  });

  it("refuses a name another connection already uses", async () => {
    testConnection.mockResolvedValue(PASSED);
    renderDialog();
    type("gateway-base-url", "https://litellm.acme.example/v1");
    submitTest();
    await screen.findByText("Responses didn't answer");
    type("gateway-name", "Taken");
    expect(screen.getByText('A custom provider named "Taken" already exists. Choose another name.')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add provider" })).toBeDisabled();
  });
  it("ignores a Test answer that arrives after the dialog moved to another connection", async () => {
    let answer: (result: GatewayConnectionTestResult) => void = () => {};
    testConnection.mockImplementation(
      () => new Promise((resolve) => { answer = resolve; }),
    );
    const view = renderDialog();
    type("gateway-base-url", "https://litellm.acme.example/v1");
    submitTest();
    expect(testConnection).toHaveBeenCalledTimes(1);

    const other: OrgModelProvider = {
      providerKey: "custom:other",
      displayName: "Other",
      baseUrl: "https://other.example/v1",
      hasSecret: true,
      runtimeLocation: "cloud",
      apis: ["chatCompletions"],
      models: [{ nativeModelId: "other-model" }],
    } as OrgModelProvider;
    view.rerender(
      <GatewayDialog
        open
        onOpenChange={vi.fn()}
        organizationId="org_1"
        editProvider={other}
        existingProviderKeys={["custom:taken"]}
        requireOrgKeys={false}
        isSaving={false}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );
    answer(PASSED);

    await waitFor(() => expect(field("gateway-base-url").value).toBe("https://other.example/v1"));
    expect(screen.queryByText("Responses didn't answer")).not.toBeInTheDocument();
    expect(screen.queryByText("claude-sonnet-4.5")).not.toBeInTheDocument();
  });

  it("drops a pending Test when the base URL changes, and lets a new one start", async () => {
    let answer: (result: GatewayConnectionTestResult) => void = () => {};
    testConnection.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    renderDialog();
    type("gateway-base-url", "https://litellm.acme.example/v1");
    submitTest();
    expect(screen.getByRole("button", { name: "Testing..." })).toBeDisabled();

    type("gateway-base-url", "https://gw.other.example/v1");
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
    await act(async () => answer(PASSED));

    expect(
      screen.queryByText("Responses didn't answer"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("claude-sonnet-4.5")).not.toBeInTheDocument();
    expect(document.getElementById("gateway-name")).toBeNull();
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();

    testConnection.mockResolvedValueOnce(PASSED);
    submitTest();
    expect(
      await screen.findByText("Responses didn't answer"),
    ).toBeInTheDocument();
    expect(testConnection).toHaveBeenLastCalledWith({
      runtimeLocation: "cloud",
      baseUrl: "https://gw.other.example/v1",
    });
  });

  it("asks for the key before testing a saved keyed gateway from the Inspector", async () => {
    renderDialog({
      providerKey: "custom:lan",
      displayName: "lan",
      enabled: true,
      hasSecret: true,
      baseUrl: "http://10.0.0.8:4000",
      runtimeLocation: "local",
      apis: ["chatCompletions"],
      models: [{ nativeModelId: "lan-model" }],
    });
    submitTest();
    expect(
      await screen.findByText("Your Inspector can't use the saved key"),
    ).toBeInTheDocument();
    expect(testConnection).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(field("gateway-secret")),
    );

    testConnection.mockResolvedValueOnce({ ...PASSED, origin: "inspector" });
    type("gateway-secret", "sk-lan");
    submitTest();
    expect(
      await screen.findByText("Tested from your Inspector"),
    ).toBeInTheDocument();
    expect(testConnection).toHaveBeenCalledWith({
      runtimeLocation: "local",
      baseUrl: "http://10.0.0.8:4000",
      secret: "sk-lan",
      providerKey: "custom:lan",
    });
  });
});
