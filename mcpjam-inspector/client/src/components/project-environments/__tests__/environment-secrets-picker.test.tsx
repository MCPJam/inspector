/**
 * The environment's credential grant, as the picker expresses it.
 *
 * Three things are pinned, and each is a way the feature would be wrong in a
 * way nobody notices until a run fails:
 *
 *   - CLEARING THE LAST SELECTION EMITS `null`, not `[]`. The backend rejects
 *     an empty array, so `[]` would fail the save; and `null` is what REVOKES
 *     the grant, which is the whole reason the field has to be clearable.
 *   - A PERSONAL secret is selectable and carries the "only your sessions"
 *     chip. Unlike skills, personal secrets are pinnable on purpose — that is
 *     the motivating workflow — and the chip is what stops a teammate's empty
 *     environment from being a mystery.
 *   - A selected id the query never returns gets a DETACH-ONLY row. Otherwise
 *     it is invisible, unremovable, and still shipped on every save.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSecrets } = vi.hoisted(() => ({
  mockSecrets: { value: undefined as unknown },
}));

vi.mock("@/hooks/useProjectSecrets", () => ({
  useProjectSecrets: () => mockSecrets.value,
}));

import { ProjectEnvironmentSecretsPicker } from "../ProjectEnvironmentSecretsPicker";

const SHARED = {
  secretId: "sec_shared",
  projectId: "proj-1",
  name: "STRIPE_API_KEY",
  delivery: "brokered" as const,
  brokerHosts: ["api.stripe.com"],
  brokerHeader: "Authorization",
  brokerTemplate: "Bearer {}",
  sharing: "project" as const,
  isOwner: false,
  createdAt: 1,
  updatedAt: 1,
  createdByUserId: "u1",
  updatedByUserId: "u1",
};

const PERSONAL = {
  ...SHARED,
  secretId: "sec_personal",
  name: "MY_GH_TOKEN",
  delivery: "materialized" as const,
  brokerHosts: undefined,
  brokerHeader: undefined,
  brokerTemplate: undefined,
  sharing: "user" as const,
  ownerUserId: "u1",
  isOwner: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSecrets.value = [SHARED, PERSONAL];
});

describe("ProjectEnvironmentSecretsPicker", () => {
  it("emits an explicit selection when a secret is checked", () => {
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSecretsPicker
        projectId="proj-1"
        value={null}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText("STRIPE_API_KEY"));
    expect(onChange).toHaveBeenCalledWith({
      mode: "explicit",
      secretIds: ["sec_shared"],
    });
  });

  it("emits NULL when the last selection is removed, never an empty array", () => {
    // `[]` is rejected by the backend, and `null` is what revokes the grant.
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSecretsPicker
        projectId="proj-1"
        value={{ mode: "explicit", secretIds: ["sec_shared"] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText("STRIPE_API_KEY"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("offers a PERSONAL secret, labelled with who actually receives it", () => {
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSecretsPicker
        projectId="proj-1"
        value={null}
        onChange={onChange}
      />,
    );
    // Selectable — this is the motivating workflow, not a mistake to prevent.
    fireEvent.click(screen.getByLabelText("MY_GH_TOKEN"));
    expect(onChange).toHaveBeenCalledWith({
      mode: "explicit",
      secretIds: ["sec_personal"],
    });
    // And labelled, so a teammate's empty run is not a mystery later.
    expect(screen.getByText("only your sessions")).toBeInTheDocument();
  });

  it("labels a materialized secret as reaching inside the box", () => {
    render(
      <ProjectEnvironmentSecretsPicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("in the box")).toBeInTheDocument();
    expect(screen.getByText("brokered")).toBeInTheDocument();
  });

  it("renders a detach-only row for a selected id the query never returns", () => {
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSecretsPicker
        projectId="proj-1"
        value={{ mode: "explicit", secretIds: ["sec_shared", "sec_gone"] }}
        onChange={onChange}
      />,
    );
    const orphan = screen.getByLabelText(/Remove missing secret sec_gone/i);
    expect(orphan).toBeInTheDocument();
    // Removable: unchecking commits the remaining ids.
    fireEvent.click(orphan);
    expect(onChange).toHaveBeenCalledWith({
      mode: "explicit",
      secretIds: ["sec_shared"],
    });
  });

  it("shows no orphan rows while the query is still loading", () => {
    // Otherwise every selection flashes as "no longer available" on mount.
    mockSecrets.value = undefined;
    render(
      <ProjectEnvironmentSecretsPicker
        projectId="proj-1"
        value={{ mode: "explicit", secretIds: ["sec_shared"] }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/No longer available/i)).not.toBeInTheDocument();
  });

  it("says plainly that no selection means no secrets", () => {
    // The fail-closed default is the surprising one, so it is stated rather
    // than left as an empty list to interpret.
    render(
      <ProjectEnvironmentSecretsPicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Runs from this environment receive none/i),
    ).toBeInTheDocument();
  });
});
