import { beforeEach, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { track } from "@/lib/analytics";
import { readAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { GenerateCasesDialog } from "../generate-cases-dialog";
import {
  loadGenerateConfig,
  totalCases,
} from "@/lib/evals/eval-generation-config";

const auth = vi.hoisted(() => ({
  hosted: false,
  user: null as { id: string } | null | undefined,
  signIn: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: auth.user, signIn: auth.signIn }),
}));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  get HOSTED_MODE() {
    return auth.hosted;
  },
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  auth.hosted = false;
  auth.user = null;
  vi.clearAllMocks();
});

it.each([null, undefined])(
  "offers sign-in instead of generation for a hosted visitor without a user (%s)",
  async (user) => {
    auth.hosted = true;
    auth.user = user;
    const onGenerate = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <GenerateCasesDialog
        suiteId="s"
        onGenerate={onGenerate}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("Sign in to generate test cases.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Generate cases" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    await userEvent.setup().keyboard("{Enter}");
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(onGenerate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(loadGenerateConfig("s").testSet).toBeUndefined();
  },
);

it("starts sign-in from the guest dialog and remembers the current suite URL", async () => {
  auth.hosted = true;
  const path = "/p/k5700000000000000000000000a/evals/suite/s?view=cases#case";
  window.history.replaceState({}, "", path);
  const onGenerate = vi.fn();
  renderWithProviders(
    <GenerateCasesDialog suiteId="s" onGenerate={onGenerate} onClose={vi.fn()} />,
  );

  await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" }));
  expect(auth.signIn).toHaveBeenCalledOnce();
  expect(readAppSignInReturnPath()).toBe(path);
  expect(track).toHaveBeenCalledWith("login_button_clicked", {
    location: "eval_generate_cases",
  });
  expect(onGenerate).not.toHaveBeenCalled();
});

it("keeps generation available for signed-in hosted users", async () => {
  auth.hosted = true;
  auth.user = { id: "signed-in-user" };
  const onGenerate = vi.fn();
  renderWithProviders(
    <GenerateCasesDialog suiteId="s" onGenerate={onGenerate} onClose={vi.fn()} />,
  );

  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Generate cases" }));
  expect(onGenerate).toHaveBeenCalledWith(
    expect.objectContaining({ testSet: "quick", toolCoverage: "read-only" }),
  );
});

it("shows the sign-in prompt if a hosted account disappears while the dialog is open", () => {
  auth.hosted = true;
  auth.user = { id: "signed-in-user" };
  const onGenerate = vi.fn();
  const view = renderWithProviders(
    <GenerateCasesDialog suiteId="s" onGenerate={onGenerate} onClose={vi.fn()} />,
  );
  expect(screen.getByRole("button", { name: "Generate cases" })).toBeVisible();

  auth.user = null;
  view.rerender(
    <GenerateCasesDialog suiteId="s" onGenerate={onGenerate} onClose={vi.fn()} />,
  );
  expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Generate cases" })).toBeNull();
  expect(onGenerate).not.toHaveBeenCalled();
});

it("keeps local generation available without an account and defaults to quick/read-only", async () => {
  const onGenerate = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onGenerate={onGenerate}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole("radio", { name: /Quick set/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /Read-only/ })).toBeChecked();
  expect(screen.queryByText(/Suite default assertions/)).toBeNull();
  expect(screen.getByText("5–10 cases")).toBeVisible();
  expect(screen.getByText("20 cases")).toBeVisible();
  expect(screen.queryByText(/depends/i)).toBeNull();
  expect(onGenerate).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  expect(onGenerate).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

it("submits and remembers comprehensive read/write settings only on confirmation", async () => {
  const onGenerate = vi.fn();
  const user = userEvent.setup();
  const view = renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onGenerate={onGenerate}
      onClose={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("radio", { name: /Comprehensive/ }));
  await user.click(screen.getByRole("radio", { name: /Read and write/ }));
  expect(onGenerate).not.toHaveBeenCalled();
  expect(loadGenerateConfig("s").testSet).toBeUndefined();
  await user.click(screen.getByRole("button", { name: "Generate cases" }));
  expect(onGenerate).toHaveBeenCalledOnce();
  const config = onGenerate.mock.calls[0][0];
  expect(config).toMatchObject({
    testSet: "comprehensive",
    toolCoverage: "read-write",
  });
  expect(totalCases(config)).toBe(20);
  view.unmount();
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onGenerate={onGenerate}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("radio", { name: /Comprehensive/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /Read and write/ })).toBeChecked();
});

it("requires a mixed suite to pick the environment it generates for", async () => {
  const onGenerate = vi.fn();
  const user = userEvent.setup();
  const choices = [
    {
      environmentId: "env-a",
      hostName: "Claude",
      modelId: "opus",
      serverNames: ["billing"],
      pluginVersionCount: 0,
    },
    {
      environmentId: "env-b",
      name: "Search box",
      hostName: "Cursor",
      serverNames: ["search"],
      pluginVersionCount: 1,
    },
  ];
  const view = renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      environmentChoices={choices}
      onGenerate={onGenerate}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText("search + 1 plugin")).toBeVisible();
  const generate = screen.getByRole("button", { name: "Generate cases" });
  expect(generate).toBeDisabled();
  await user.click(screen.getByRole("radio", { name: /Search box/ }));
  await user.click(generate);
  expect(onGenerate).toHaveBeenCalledWith(
    expect.objectContaining({ environmentId: "env-b" }),
  );
  expect(loadGenerateConfig("s").environmentId).toBe("env-b");

  // The pick is remembered for the next batch.
  view.unmount();
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      environmentChoices={choices}
      onGenerate={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("radio", { name: /Search box/ })).toBeChecked();
  expect(
    screen.getByRole("button", { name: "Generate cases" }),
  ).not.toBeDisabled();
});

it("sends no environment for a suite with nothing to pick", async () => {
  const onGenerate = vi.fn();
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onGenerate={onGenerate}
      onClose={vi.fn()}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Generate cases" }));
  expect(onGenerate.mock.calls[0][0]).not.toHaveProperty("environmentId");
});
