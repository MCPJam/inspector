import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShownCompanyStep } from "@/hooks/useWorkOrganizations";
import { CompanyStep, personalLabel, workLabel } from "../CompanyStep";

const JOIN: ShownCompanyStep = {
  step: "join",
  organizationId: "org_acme",
  name: "Acme",
  domain: "acme.com",
};
const OWNER: ShownCompanyStep = { ...JOIN, step: "owner" };

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderStep(
  overrides: Partial<Parameters<typeof CompanyStep>[0]> = {},
) {
  const actions = {
    ask: vi.fn(() => Promise.resolve()),
    continue: vi.fn(() => Promise.resolve()),
  };
  const onDone = vi.fn();
  render(
    <CompanyStep
      step={JOIN}
      personalOrganizationName="Jo's Org"
      email="jo@acme.com"
      userId="user_jo"
      actions={actions}
      onDone={onDone}
      {...overrides}
    />,
  );
  return { actions, onDone };
}

const button = (name: string) => screen.getByRole("button", { name });

describe("CompanyStep", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it("labels the organizations in one place", () => {
    expect(workLabel("Acme")).toBe("Acme (Work)");
    expect(personalLabel("Jo's Org")).toBe("Jo's Org (Personal)");
    expect(personalLabel(null)).toBe("your Personal organization");
  });

  it("asks to join the Work organization", () => {
    renderStep();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Join Acme (Work) on MCPJam?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "An owner or admin approves new members of your company's Work organization.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Acme (Work)")).toBeInTheDocument();
    expect(
      screen.getByText("Work organization for acme.com"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button").map((element) => element.textContent),
    ).toEqual(["Ask to join", "Continue in Personal"]);
    expect(
      screen.getByText("Your projects stay in Jo's Org (Personal) either way."),
    ).toBeInTheDocument();
    expect(screen.getByText("Signed in as jo@acme.com")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "MCPJam" })).toHaveAttribute(
      "src",
      "/mcp_jam.svg",
    );
  });

  it("sends the request, then shows it was sent and focuses Continue", async () => {
    const { actions, onDone } = renderStep();
    const pending = deferred();
    actions.ask.mockReturnValue(pending.promise);

    fireEvent.click(button("Ask to join"));
    expect(actions.ask).toHaveBeenCalledTimes(1);
    expect(button("Ask to join")).toBeDisabled();
    expect(button("Continue in Personal")).toBeDisabled();
    expect(button("Ask to join").closest("[aria-busy]")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(button("Ask to join").querySelector(".animate-spin")).not.toBeNull();

    await act(async () => pending.resolve());

    expect(
      screen.getByRole("heading", { name: "Request sent to Acme (Work)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "You'll get an email when an owner or admin approves it. Until then you work in your Personal organization.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    expect(
      screen.getByText("Work organization for acme.com"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(button("Continue")).toHaveFocus();
    expect(screen.getByText("Signed in as jo@acme.com")).toBeInTheDocument();

    fireEvent.click(button("Continue"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(actions.continue).not.toHaveBeenCalled();
    expect(actions.ask).toHaveBeenCalledTimes(1);
  });

  it("says the request was not sent and lets them try again", async () => {
    const { actions } = renderStep();
    actions.ask.mockRejectedValueOnce(new Error("offline"));

    await act(async () => fireEvent.click(button("Ask to join")));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't send your request. Try again, or continue in Personal and ask from Home later.",
    );
    expect(button("Ask to join")).toBeEnabled();
    expect(button("Continue in Personal")).toBeEnabled();
    expect(button("Ask to join").closest("[aria-busy]")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(consoleError).toHaveBeenCalled();

    await act(async () => fireEvent.click(button("Ask to join")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Request sent to Acme (Work)" }),
    ).toBeInTheDocument();
  });

  it("continues in Personal after saving the choice", async () => {
    const { actions, onDone } = renderStep();
    const pending = deferred();
    actions.continue.mockReturnValue(pending.promise);

    fireEvent.click(button("Continue in Personal"));
    expect(actions.continue).toHaveBeenCalledTimes(1);
    expect(button("Ask to join")).toBeDisabled();
    expect(onDone).not.toHaveBeenCalled();

    await act(async () => pending.resolve());
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(actions.ask).not.toHaveBeenCalled();
  });

  it("still leaves the step when saving the choice fails", async () => {
    const { actions, onDone } = renderStep();
    actions.continue.mockRejectedValueOnce(new Error("offline"));

    await act(async () => fireEvent.click(button("Continue in Personal")));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it("tells the first signup they own the Work organization", async () => {
    const { actions, onDone } = renderStep({
      step: OWNER,
      personalOrganizationName: "Alex's Org",
      email: "alex@acme.com",
    });
    expect(
      screen.getByRole("heading", {
        name: "You’re now the owner of Acme (Work)",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "You’re the first person from acme.com to sign up, so you own your company’s Work organization. You’re in Alex's Org (Personal) for now.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Work organization for acme.com"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button").map((element) => element.textContent),
    ).toEqual(["Continue to Alex's Org (Personal)"]);
    expect(screen.queryByText(/Set up|Move/)).toBeNull();
    expect(screen.getByText("Signed in as alex@acme.com")).toBeInTheDocument();

    await act(async () =>
      fireEvent.click(button("Continue to Alex's Org (Personal)")),
    );
    expect(actions.continue).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("names the Personal organization by a phrase when its name is unknown", () => {
    renderStep({ step: OWNER, personalOrganizationName: null });
    expect(
      button("Continue to your Personal organization"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/You’re in your Personal organization for now\./),
    ).toBeInTheDocument();
  });

  it("says who is signed in without an email", () => {
    renderStep({ email: null });
    expect(screen.getByText("Signed in to MCPJam")).toBeInTheDocument();
  });
});
