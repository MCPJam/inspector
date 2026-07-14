import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  XAAPeopleStrip,
  type XaaPersonOutcome,
} from "../XAAPeopleStrip";
import type { RemoteXaaPerson } from "@/hooks/useXaaPeople";

// Avoid the chatboxes import chain — only the avatar is borrowed from it.
vi.mock("@/components/chatboxes/personas", () => ({
  CharacterAvatar: ({ name }: { name: string }) => (
    <span data-testid="avatar">{name[0]}</span>
  ),
}));

const createMock = vi.fn();
const updateMock = vi.fn();
const removeMock = vi.fn();
vi.mock("@/hooks/useXaaPeople", () => ({
  useXaaPeopleMutations: () => ({
    create: createMock,
    update: updateMock,
    remove: removeMock,
  }),
}));

const bob: RemoteXaaPerson = {
  _id: "person_bob",
  name: "Bob Tables",
  subject: "bob-001",
  email: "bob@tables.test",
  createdAt: 1,
  updatedAt: 2,
};
const jonah: RemoteXaaPerson = {
  _id: "person_jonah",
  name: "Jonah Kim",
  subject: "jonah-ext-9",
  email: "jonah@contractor.test",
  createdAt: 1,
  updatedAt: 2,
};

function renderStrip(
  overrides: Partial<Parameters<typeof XAAPeopleStrip>[0]> = {},
) {
  const props = {
    people: [bob, jonah] as RemoteXaaPerson[] | undefined,
    isLoading: false,
    isAvailable: true,
    projectId: "proj_1" as string | null,
    selectedPersonId: null as string | null,
    onSelectPerson: vi.fn(),
    disabled: false,
    outcomeFor: (() => undefined) as (
      id: string,
    ) => XaaPersonOutcome | undefined,
    ...overrides,
  };
  return { ...render(<XAAPeopleStrip {...props} />), props };
}

describe("XAAPeopleStrip", () => {
  beforeEach(() => {
    createMock.mockReset();
    updateMock.mockReset();
    removeMock.mockReset();
  });

  it("renders nothing when the roster is unavailable (signed out / no project)", () => {
    const { container } = renderStrip({ isAvailable: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while loading", () => {
    const { container } = renderStrip({ people: undefined, isLoading: true });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only the ghost add button for an empty roster", () => {
    renderStrip({ people: [] });
    expect(
      screen.getByRole("button", { name: /run as/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Run as")).not.toBeInTheDocument();
  });

  it("renders a chip per person and toggles selection", async () => {
    const user = userEvent.setup();
    const { props } = renderStrip({ selectedPersonId: bob._id });

    // `pressed` distinguishes the chip from the per-chip edit button.
    const bobChip = screen.getByRole("button", {
      name: /bob tables/i,
      pressed: true,
    });

    // Clicking the selected chip deselects; clicking another selects it.
    await user.click(bobChip);
    expect(props.onSelectPerson).toHaveBeenCalledWith(null);
    await user.click(
      screen.getByRole("button", { name: /jonah kim/i, pressed: false }),
    );
    expect(props.onSelectPerson).toHaveBeenCalledWith(jonah._id);
  });

  it("ignores chip clicks while disabled (busy run)", async () => {
    const user = userEvent.setup();
    const { props } = renderStrip({ disabled: true });
    await user.click(
      screen.getByRole("button", { name: /bob tables/i, pressed: false }),
    );
    expect(props.onSelectPerson).not.toHaveBeenCalled();
  });

  it("blocks the edit popover while disabled — no mid-run edit/delete back door", async () => {
    const user = userEvent.setup();
    renderStrip({ disabled: true });
    // The pencil is still rendered (discoverable) but opening is inert, so
    // the running identity can't be mutated or deleted through the form.
    await user.click(screen.getByRole("button", { name: /edit bob tables/i }));
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
  });

  it("renders outcome badges from outcomeFor", () => {
    renderStrip({
      outcomeFor: (id) =>
        id === bob._id
          ? { status: "allowed" }
          : {
              status: "rejected",
              oauthErrorCode: "invalid_grant",
              failedStep: "jwt_bearer_request",
            },
    });
    expect(screen.getByText("Allowed")).toBeInTheDocument();
    expect(screen.getByText(/Rejected · invalid_grant/)).toBeInTheDocument();
  });

  it("requires name, subject, AND email before a person can be added", async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue({});
    renderStrip();

    await user.click(screen.getByRole("button", { name: /add person/i }));
    // Both the trigger and the form submit are named "Add person" — the
    // submit is the type="submit" one inside the popover.
    const save = (
      await screen.findAllByRole("button", { name: /add person/i })
    ).find((button) => button.getAttribute("type") === "submit")!;
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText(/name/i), "Amara Okafor");
    await user.type(screen.getByLabelText(/subject/i), "amara-002");
    expect(save).toBeDisabled(); // email still missing — identities are atomic
    await user.type(screen.getByLabelText(/email/i), "amara@tables.test");
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        projectId: "proj_1",
        name: "Amara Okafor",
        subject: "amara-002",
        email: "amara@tables.test",
      }),
    );
  });

  it("deleting the selected person clears the selection", async () => {
    const user = userEvent.setup();
    removeMock.mockResolvedValue({ ok: true });
    const { props } = renderStrip({ selectedPersonId: bob._id });

    await user.click(screen.getByRole("button", { name: /edit bob tables/i }));
    await user.click(await screen.findByRole("button", { name: /delete/i }));

    await waitFor(() =>
      expect(removeMock).toHaveBeenCalledWith({ testIdentityId: bob._id }),
    );
    expect(props.onSelectPerson).toHaveBeenCalledWith(null);
  });
});
