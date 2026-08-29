/**
 * What a cancelled secret dialog must leave behind: nothing.
 *
 * The Rotate dialog is ONE instance reused for every row, so a value that
 * survives a cancel is not merely untidy — it is shown pre-filled the next time
 * the dialog opens, against whichever secret was picked then, with the Rotate
 * button enabled because it only checks that the field is non-empty. Someone
 * who typed nothing can commit a rotation of the wrong credential.
 *
 * The trap these tests exist to catch is specific: Radix fires its own
 * `onOpenChange` for user-initiated closes (Esc, overlay, the X) but NOT for a
 * close driven by the `open` prop. A Cancel button wired straight to the prop
 * therefore skips whatever reset lives in the Radix handler, and every manual
 * check of "does Esc clear the field?" still passes.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    secrets: undefined as unknown,
    environments: [] as unknown,
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("@/hooks/useProjectSecrets", () => ({
  useProjectSecrets: () => mocks.secrets,
  useCreateProjectSecret: () => mocks.create,
  useUpdateProjectSecret: () => mocks.update,
  useDeleteProjectSecret: () => mocks.remove,
}));

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => mocks.environments,
}));

import { ProjectSecretsSection } from "../ProjectSecretsSection";

const STRIPE = {
  secretId: "sec_stripe",
  projectId: "proj-1",
  name: "STRIPE_API_KEY",
  delivery: "brokered" as const,
  brokerHosts: ["api.stripe.com"],
  brokerHeader: "Authorization",
  brokerTemplate: "Bearer {}",
  sharing: "project" as const,
  isOwner: true,
  createdAt: 1,
  updatedAt: 1,
  createdByUserId: "u1",
  updatedByUserId: "u1",
};

const GITHUB = {
  ...STRIPE,
  secretId: "sec_github",
  name: "GH_TOKEN",
  delivery: "materialized" as const,
  brokerHosts: undefined,
  brokerHeader: undefined,
  brokerTemplate: undefined,
};

function renderSection() {
  return render(<ProjectSecretsSection projectId="proj-1" canManageShared />);
}

/** Open the rotate dialog for one row, by the button's title. */
function openRotate(name: string) {
  const rows = screen.getAllByTitle("Rotate this secret's value");
  const index = [STRIPE.name, GITHUB.name].indexOf(name);
  fireEvent.click(rows[index]!);
}

const rotateField = () =>
  screen.getByLabelText(/new value/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.secrets = [STRIPE, GITHUB];
  mocks.environments = [];
});

describe("ProjectSecretsSection — rotate dialog", () => {
  it("does not carry a cancelled value into the NEXT secret's rotation", () => {
    // The whole reason the reset matters. Type against one secret, cancel, open
    // another: the field must be empty, and Rotate must be unclickable.
    renderSection();

    openRotate("STRIPE_API_KEY");
    fireEvent.change(rotateField(), { target: { value: "sk_live_typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    openRotate("GH_TOKEN");
    expect(rotateField().value).toBe("");
    expect(screen.getByRole("button", { name: "Rotate" })).toBeDisabled();
  });

  it("clears the field when the SAME secret is reopened after a cancel", () => {
    renderSection();

    openRotate("STRIPE_API_KEY");
    fireEvent.change(rotateField(), { target: { value: "sk_live_typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    openRotate("STRIPE_API_KEY");
    expect(rotateField().value).toBe("");
  });

  it("submits nothing when the rotation is cancelled", () => {
    renderSection();

    openRotate("STRIPE_API_KEY");
    fireEvent.change(rotateField(), { target: { value: "sk_live_typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("clears a failed rotation's error before the next attempt", () => {
    // An error left over from a cancelled attempt reads as a fresh failure
    // against a secret the user has not tried yet.
    mocks.update.mockRejectedValueOnce(new Error("Rotation refused"));
    renderSection();

    openRotate("STRIPE_API_KEY");
    fireEvent.change(rotateField(), { target: { value: "sk_live_typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    openRotate("GH_TOKEN");
    expect(screen.queryByText(/Rotation refused/i)).not.toBeInTheDocument();
  });
});

describe("ProjectSecretsSection — create dialog", () => {
  const openCreate = () =>
    fireEvent.click(screen.getByRole("button", { name: /new secret/i }));

  it("clears a cancelled draft, including the value", () => {
    renderSection();

    openCreate();
    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: "MY_KEY" },
    });
    fireEvent.change(screen.getByLabelText(/^value$/i), {
      target: { value: "sk_live_typed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    openCreate();
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe(
      "",
    );
    expect((screen.getByLabelText(/^value$/i) as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("submits nothing when the draft is cancelled", () => {
    renderSection();

    openCreate();
    fireEvent.change(screen.getByLabelText(/^value$/i), {
      target: { value: "sk_live_typed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mocks.create).not.toHaveBeenCalled();
  });
});
