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
import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("warns when ROTATING a materialized secret to a short value", () => {
    // A value enters the system by two routes, and this is the one where nobody
    // is re-reading the delivery explanation. GH_TOKEN is materialized.
    renderSection();
    openRotate("GH_TOKEN");

    fireEvent.change(rotateField(), { target: { value: "short" } });
    expect(screen.getByText(/not be redacted/i)).toBeInTheDocument();

    fireEvent.change(rotateField(), { target: { value: "ghp_long_enough" } });
    expect(screen.queryByText(/not be redacted/i)).not.toBeInTheDocument();

    // Cleared back to empty is its own branch in `ShortValueWarning`, and it
    // has to stay silent: an empty field is someone who has not typed a value
    // yet, not someone about to save an unscrubbable one. Warning there would
    // put a red box on every freshly-opened rotate dialog.
    fireEvent.change(rotateField(), { target: { value: "" } });
    expect(screen.queryByText(/not be redacted/i)).not.toBeInTheDocument();
  });

  it("does not warn when rotating a BROKERED secret to a short value", () => {
    // STRIPE_API_KEY is brokered: the value never enters the box, so there is
    // nothing for the transcript scrubber to have missed.
    renderSection();
    openRotate("STRIPE_API_KEY");

    fireEvent.change(rotateField(), { target: { value: "short" } });
    expect(screen.queryByText(/not be redacted/i)).not.toBeInTheDocument();
  });

  it("submits nothing when the rotation is cancelled", () => {
    renderSection();

    openRotate("STRIPE_API_KEY");
    fireEvent.change(rotateField(), { target: { value: "sk_live_typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not let a rotation that FAILS LATE blame the next secret", async () => {
    // Escape closes this dialog even mid-write — only the Cancel *button* is
    // disabled while busy — so a rotation can still be in flight when the
    // dialog is reopened against a different row. Its late error must not land
    // on a secret the user has not tried yet.
    let reject!: (error: Error) => void;
    mocks.update.mockReturnValueOnce(
      new Promise((_resolve, r) => {
        reject = r;
      }),
    );
    renderSection();

    openRotate("STRIPE_API_KEY");
    fireEvent.change(rotateField(), { target: { value: "sk_live_typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));

    // Close through Escape, which Radix honours regardless of `busy`.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
      code: "Escape",
    });
    openRotate("GH_TOKEN");

    await act(async () => {
      reject(new Error("Rotation refused"));
      await Promise.resolve();
    });

    expect(screen.queryByText(/Rotation refused/i)).not.toBeInTheDocument();
    expect(rotateField().value).toBe("");
    // And the reopened dialog is USABLE. The abandoned request skips its own
    // `setBusy(false)` — it no longer owns the state — so closing has to clear
    // `busy`, or this component (reused, never unmounted) stays disabled for
    // good and the user can neither rotate nor cancel.
    fireEvent.change(rotateField(), { target: { value: "ghp_after" } });
    expect(screen.getByRole("button", { name: "Rotate" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("does not let a rotation that SUCCEEDS LATE clear the next secret's field", async () => {
    // The mirror case: the late success path calls setValue("") and closes.
    // Applied to the reopened dialog it would wipe what the user just typed
    // and shut the dialog under them.
    let resolve!: (value: unknown) => void;
    mocks.update.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderSection();

    openRotate("STRIPE_API_KEY");
    fireEvent.change(rotateField(), { target: { value: "sk_live_typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
      code: "Escape",
    });

    openRotate("GH_TOKEN");
    fireEvent.change(rotateField(), { target: { value: "ghp_fresh" } });

    await act(async () => {
      resolve({});
      await Promise.resolve();
    });

    expect(rotateField().value).toBe("ghp_fresh");
    expect(screen.getByRole("button", { name: "Rotate" })).toBeEnabled();
  });
});

describe("ProjectSecretsSection — delete confirmation", () => {
  /** Open the delete confirmation for one row, by the button's title. */
  const openDelete = (name: string) => {
    const rows = screen.getAllByTitle("Delete this secret");
    const index = [STRIPE.name, GITHUB.name].indexOf(name);
    fireEvent.click(rows[index]!);
  };

  const clickConfirm = () =>
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

  const pressEscape = () =>
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
      code: "Escape",
    });

  /**
   * Abandon a pending delete of STRIPE and open GH_TOKEN's confirmation in its
   * place, returning the settle function for the abandoned request.
   *
   * Only the Cancel BUTTON is disabled while a delete is in flight — Esc still
   * closes the dialog, and the row buttons behind it are gated on permission,
   * not on `busy` — so this sequence is reachable by an ordinary user, not just
   * in principle.
   */
  const abandonStripeDeleteThenOpenGithub = () => {
    let settle!: (outcome: { ok: true } | { error: Error }) => void;
    mocks.remove.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        settle = (outcome) =>
          "error" in outcome ? reject(outcome.error) : resolve(outcome);
      }),
    );
    renderSection();

    openDelete("STRIPE_API_KEY");
    clickConfirm();
    pressEscape();

    openDelete("GH_TOKEN");
    expect(screen.getByText("Delete GH_TOKEN?")).toBeInTheDocument();
    return settle;
  };

  it("does not close another secret's confirmation when a stale delete succeeds", async () => {
    const settle = abandonStripeDeleteThenOpenGithub();

    await act(async () => {
      settle({ ok: true });
      await Promise.resolve();
    });

    // The abandoned STRIPE request must not reach in and dismiss the dialog the
    // user is now looking at — which would read as the delete having happened.
    expect(screen.getByText("Delete GH_TOKEN?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("does not report a stale delete's failure against another secret", async () => {
    const settle = abandonStripeDeleteThenOpenGithub();

    await act(async () => {
      settle({ error: new Error("stripe key is still in use") });
      await Promise.resolve();
    });

    // STRIPE's failure shown under GH_TOKEN's name is worse than showing
    // nothing: it invites the user to act on the wrong credential.
    expect(
      screen.queryByText("stripe key is still in use"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Delete GH_TOKEN?")).toBeInTheDocument();
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

  it("leaves the reopened dialog usable after a stale create settles", async () => {
    // The create-side twin of the rotate race: Escape closes mid-write, the
    // abandoned request skips its own `setBusy(false)`, and without clearing
    // `busy` on close the dialog reopens permanently disabled.
    let resolve!: (value: unknown) => void;
    mocks.create.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderSection();

    const fillDraft = (name: string, value: string) => {
      fireEvent.change(screen.getByLabelText(/^name$/i), {
        target: { value: name },
      });
      fireEvent.change(screen.getByLabelText(/^value$/i), {
        target: { value },
      });
      // The default delivery is brokered, which needs a host before Save is
      // reachable at all — otherwise this would assert on `brokerValid`, not
      // on `busy`.
      fireEvent.change(screen.getByLabelText(/^hosts$/i), {
        target: { value: "api.stripe.com" },
      });
    };

    openCreate();
    fillDraft("MY_KEY", "sk_live_typed");
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
      code: "Escape",
    });

    openCreate();
    await act(async () => {
      resolve({});
      await Promise.resolve();
    });

    // Cancel is gated on `busy` ALONE, so it isolates the bug exactly.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    fillDraft("OTHER_KEY", "sk_live_other");
    expect(screen.getByRole("button", { name: "Save secret" })).toBeEnabled();
  });

  it("warns that a short MATERIALIZED value will not be redacted", () => {
    // The scrubber skips values under 8 characters on purpose — replacing a
    // 4-character string would rewrite unrelated transcript text. That trade is
    // right and invisible, so the form says it where the value is typed rather
    // than leaving it to be found later in a saved conversation.
    renderSection();
    openCreate();

    fireEvent.click(screen.getByRole("radio", { name: /materialized/i }));
    fireEvent.change(screen.getByLabelText(/^value$/i), {
      target: { value: "short" },
    });
    expect(screen.getByText(/not be redacted/i)).toBeInTheDocument();

    // Gone once the value is long enough to be registered.
    fireEvent.change(screen.getByLabelText(/^value$/i), {
      target: { value: "sk_live_long_enough" },
    });
    expect(screen.queryByText(/not be redacted/i)).not.toBeInTheDocument();
  });

  it("does not warn for a short BROKERED value, which never enters the box", () => {
    renderSection();
    openCreate();

    fireEvent.change(screen.getByLabelText(/^value$/i), {
      target: { value: "short" },
    });
    expect(screen.queryByText(/not be redacted/i)).not.toBeInTheDocument();
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
