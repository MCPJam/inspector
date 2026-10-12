import { beforeEach, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { GenerateCasesDialog } from "../generate-cases-dialog";
import { EvalGenerationWorkspace } from "../eval-generation-workspace";
import { EvalGenerationAccess } from "../eval-generation-access";
import { readAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { startEvalGeneration } from "@/lib/mcpjam-agent/eval-workspace";

const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  isLoading: false,
  signIn: vi.fn(),
}));
const config = vi.hoisted(() => ({ hosted: true }));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => auth }));
vi.mock("@/lib/config", async (original) => ({
  ...(await original<object>()),
  get HOSTED_MODE() {
    return config.hosted;
  },
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/mcpjam-agent/eval-workspace", async (original) => ({
  ...(await original<object>()),
  startEvalGeneration: vi.fn(),
}));

const target = { projectId: "p", suiteId: "s", suiteName: "Suite" };
beforeEach(() => {
  auth.user = null;
  auth.isLoading = false;
  config.hosted = true;
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

it("shows guests an actionable sign-in prompt instead of generation settings", async () => {
  const onGenerate = vi.fn();
  const returnPath = "/p/k5700000000000000000000000a/evals/suite/s?view=cases";
  window.history.replaceState({}, "", returnPath);
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onClose={vi.fn()}
      onGenerate={onGenerate}
    />,
  );
  expect(
    screen.getByRole("dialog", { name: "Generate test cases" }),
  ).toBeVisible();
  expect(screen.getByText(/You can still add cases manually/)).toBeVisible();
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.queryByRole("button", { name: "Generate cases" })).toBeNull();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in" }));
  expect(auth.signIn).toHaveBeenCalledOnce();
  expect(readAppSignInReturnPath()).toBe(returnPath);
  expect(onGenerate).not.toHaveBeenCalled();
});

it("does not mount the generation workspace or start discovery for a guest", () => {
  renderWithProviders(<EvalGenerationWorkspace {...target} />);
  expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(screen.queryByTestId("suite-case-generation-workspace")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry generation" })).toBeNull();
  expect(startEvalGeneration).not.toHaveBeenCalled();
});

it("waits for WorkOS identity before mounting auto-start generation", () => {
  auth.isLoading = true;
  const view = renderWithProviders(<EvalGenerationWorkspace {...target} />);
  expect(screen.getByRole("status")).toHaveTextContent("Checking sign-in");
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(startEvalGeneration).not.toHaveBeenCalled();
  auth.isLoading = false;
  auth.user = { id: "member" };
  view.rerender(<EvalGenerationWorkspace {...target} />);
  expect(screen.getByTestId("suite-case-generation-workspace")).toBeVisible();
  expect(startEvalGeneration).toHaveBeenCalledOnce();
});

it("reveals settings after sign-in and generates only on confirmation", async () => {
  const onGenerate = vi.fn();
  const dialog = () => (
    <GenerateCasesDialog
      suiteId="s"
      onClose={vi.fn()}
      onGenerate={onGenerate}
    />
  );
  const view = renderWithProviders(dialog());
  auth.user = { id: "member" };
  view.rerender(dialog());
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(screen.getByRole("radio", { name: /Quick set/ })).toBeChecked();
  expect(onGenerate).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Generate cases" }));
  expect(onGenerate).toHaveBeenCalledOnce();
});

it("removes generation controls if the account signs out", () => {
  auth.user = { id: "member" };
  const dialog = () => (
    <GenerateCasesDialog suiteId="s" onClose={vi.fn()} onGenerate={vi.fn()} />
  );
  const view = renderWithProviders(dialog());
  expect(screen.getByRole("button", { name: "Generate cases" })).toBeVisible();
  auth.user = null;
  view.rerender(dialog());
  expect(screen.queryByRole("button", { name: "Generate cases" })).toBeNull();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
});

it("does not gate local generation on a WorkOS account", () => {
  config.hosted = false;
  auth.isLoading = true;
  renderWithProviders(
    <EvalGenerationAccess>
      <button>Local generation</button>
    </EvalGenerationAccess>,
  );
  expect(
    screen.getByRole("button", { name: "Local generation" }),
  ).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();
});
