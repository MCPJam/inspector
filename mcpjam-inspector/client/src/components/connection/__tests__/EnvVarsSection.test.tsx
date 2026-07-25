import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { EnvVarsSection } from "../shared/EnvVarsSection";

type EnvVar = { key: string; value: string };

function valueInput(name: string) {
  return screen.getByLabelText(`Environment variable ${name} value`);
}

/** Mirrors how the add/edit forms own the rows, so index-shifting on remove is
 * exercised against real state rather than a static array. */
function Harness({
  initial = [],
  hasStoredEnv = false,
  onReveal,
}: {
  initial?: EnvVar[];
  hasStoredEnv?: boolean;
  onReveal?: () => void;
}) {
  const [envVars, setEnvVars] = useState<EnvVar[]>(initial);
  return (
    <EnvVarsSection
      envVars={envVars}
      showEnvVars
      onToggle={vi.fn()}
      onAdd={() => setEnvVars((prev) => [...prev, { key: "", value: "" }])}
      onRemove={(index) =>
        setEnvVars((prev) => prev.filter((_, at) => at !== index))
      }
      onUpdate={(index, field, value) =>
        setEnvVars((prev) =>
          prev.map((row, at) => (at === index ? { ...row, [field]: value } : row))
        )
      }
      hasStoredEnv={hasStoredEnv}
      onReveal={onReveal}
    />
  );
}

describe("EnvVarsSection value masking", () => {
  it("masks existing values until the eye is clicked", async () => {
    const user = userEvent.setup();
    render(
      <Harness initial={[{ key: "OPENAI_API_KEY", value: "sk-proj-secret" }]} />
    );

    expect(valueInput("1")).toHaveAttribute("type", "password");

    await user.click(
      screen.getByRole("button", { name: "Show value for OPENAI_API_KEY" })
    );
    expect(valueInput("1")).toHaveAttribute("type", "text");

    await user.click(
      screen.getByRole("button", { name: "Hide value for OPENAI_API_KEY" })
    );
    expect(valueInput("1")).toHaveAttribute("type", "password");
  });

  it("leaves a newly added row unmasked so it can be typed into", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Add variable" }));

    expect(valueInput("1")).toHaveAttribute("type", "text");
  });

  it("keeps eye state on the right row after one is removed", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[
          { key: "FIRST", value: "one" },
          { key: "SECOND", value: "two" },
          { key: "THIRD", value: "three" },
        ]}
      />
    );

    // Unmask the last row, then delete the row above it. Without re-indexing,
    // the eye state would slide onto SECOND and expose the wrong value.
    await user.click(screen.getByRole("button", { name: "Show value for THIRD" }));
    await user.click(screen.getByRole("button", { name: "Remove SECOND" }));

    expect(valueInput("1")).toHaveAttribute("type", "password");
    expect(valueInput("2")).toHaveAttribute("type", "text");
    expect(
      screen.getByRole("button", { name: "Hide value for THIRD" })
    ).toBeInTheDocument();
  });

  it("shows the rows that a stored-secret reveal brings back", async () => {
    const user = userEvent.setup();

    function RevealHarness() {
      const [envVars, setEnvVars] = useState<EnvVar[]>([]);
      return (
        <EnvVarsSection
          envVars={envVars}
          showEnvVars
          onToggle={vi.fn()}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
          onUpdate={vi.fn()}
          hasStoredEnv
          onReveal={() => setEnvVars([{ key: "TOKEN", value: "revealed" }])}
        />
      );
    }

    render(<RevealHarness />);
    await user.click(screen.getByRole("button", { name: /Reveal/ }));

    expect(valueInput("1")).toHaveAttribute("type", "text");
  });
});
