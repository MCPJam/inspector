import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { XAASimulatedIdentity } from "../XAASimulatedIdentity";

const RUN_SETTINGS_KEY = "mcpjam-xaa-run-settings/v1";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("XAASimulatedIdentity", () => {
  it("does not flag the trigger when the identity is default", () => {
    render(<XAASimulatedIdentity />);
    expect(
      screen.getByRole("button", { name: /edit simulated identity/i }),
    ).toBeInTheDocument();
    // No non-default indicator dot in the DOM yet.
    expect(
      document.querySelector("span.rounded-full.bg-primary"),
    ).toBeNull();
  });

  it("edits sub + email and persists them globally", async () => {
    const user = userEvent.setup();
    render(<XAASimulatedIdentity />);

    await user.click(
      screen.getByRole("button", { name: /edit simulated identity/i }),
    );

    const sub = screen.getByLabelText("Subject (sub)");
    await user.clear(sub);
    await user.type(sub, "person-99");
    const email = screen.getByLabelText("Email");
    await user.clear(email);
    await user.type(email, "person@example.com");

    const stored = JSON.parse(localStorage.getItem(RUN_SETTINGS_KEY) ?? "{}");
    expect(stored.userId).toBe("person-99");
    expect(stored.email).toBe("person@example.com");
  });

  it("shows the non-default indicator when a custom identity is stored", () => {
    localStorage.setItem(
      RUN_SETTINGS_KEY,
      JSON.stringify({
        userId: "custom",
        email: "custom@example.com",
        negativeTestMode: "valid",
      }),
    );

    render(<XAASimulatedIdentity />);
    expect(
      document.querySelector("span.rounded-full.bg-primary"),
    ).not.toBeNull();
  });
});
