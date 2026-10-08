/**
 * The /evals create dialog in compose mode: the server group is seeded and
 * REQUIRED, like the create page — an eval environment born without one runs
 * with no servers.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  composerProps: [] as Array<Record<string, any>>,
  resolverOptions: [] as unknown[],
  resolve: vi.fn(),
  serverAttachments: [] as Array<{ _id: string; name: string }>,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: mocks.serverAttachments,
  }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [{ hostId: "host-1", name: "Claude", modelId: "sonnet" }],
  }),
}));
vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => ["host-1"],
}));
vi.mock("@/components/environment-composer/use-eval-compose-capable", () => ({
  useEvalComposeCapable: () => ({ capable: true, pending: false }),
}));
vi.mock("@/components/environment-composer/use-composer-resolver", () => ({
  useComposerResolver: (_projectId: string, options: unknown) => {
    mocks.resolverOptions.push(options);
    return mocks.resolve;
  },
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [],
}));
vi.mock("@/components/environment-composer/environment-composer", () => ({
  EVALS_COMPOSER_SLOTS: [],
  EnvironmentComposer: (props: Record<string, any>) => {
    mocks.composerProps.push(props);
    return (
      <div data-testid="composer">
        {props.value.stack.serverAttachmentId ?? "no-group"}
      </div>
    );
  },
}));
vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: () => null,
}));
vi.mock("../client-attachments-editor", () => ({
  ClientAttachmentsEditor: () => null,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));

import { CreateSuiteDialog } from "../create-suite-dialog";

beforeEach(() => {
  mocks.composerProps.length = 0;
  mocks.resolverOptions.length = 0;
  mocks.resolve.mockReset();
  mocks.serverAttachments = [{ _id: "group-1", name: "Stripe" }];
});

function renderDialog(onSubmit = vi.fn(async () => {})) {
  render(
    <CreateSuiteDialog
      open
      onOpenChange={vi.fn()}
      onSubmit={onSubmit}
      hostsEnabled
      projectId="project-1"
      initialName="Checkout"
    />,
  );
  return onSubmit;
}

it("seeds the first server group and marks the slot required", async () => {
  renderDialog();
  await waitFor(() =>
    expect(screen.getByTestId("composer")).toHaveTextContent("group-1"),
  );
  expect(mocks.composerProps.at(-1)?.serverOptional).toBe(false);
  expect(mocks.resolverOptions.at(-1)).toEqual({
    requireServerAttachment: true,
  });
});

it("refuses to create without a server group", async () => {
  mocks.serverAttachments = [];
  const onSubmit = renderDialog();
  await waitFor(() =>
    expect(screen.getByTestId("composer")).toHaveTextContent("no-group"),
  );
  const create = screen.getByRole("button", { name: "Create suite" });
  expect(create).toBeDisabled();
  fireEvent.click(create);
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
});

it("creates with the seeded group", async () => {
  mocks.resolve.mockResolvedValue({
    environmentIds: ["env-1"],
    environments: [
      {
        environmentId: "env-1",
        hostId: "host-1",
        serverAttachmentId: "group-1",
      },
    ],
    createdIds: ["env-1"],
    reusedIds: [],
  });
  const onSubmit = renderDialog();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Create suite" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create suite" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  expect(mocks.resolve.mock.calls[0][0].state.stack.serverAttachmentId).toBe(
    "group-1",
  );
  expect(onSubmit.mock.calls[0][0]).toMatchObject({
    name: "Checkout",
    environmentIds: ["env-1"],
  });
});
