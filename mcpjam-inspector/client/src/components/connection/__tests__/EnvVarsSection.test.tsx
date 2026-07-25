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

  it("fetches stored values on open and names the rows without unmasking them", () => {
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
          onReveal={() =>
            setEnvVars([
              { key: "TOKEN", value: "revealed" },
              { key: "LOG_LEVEL", value: "debug" },
            ])
          }
        />
      );
    }

    render(<RevealHarness />);

    // No click: opening the section is what fetches them. The point is that the
    // user can see *which* variables are set, so the keys are readable...
    expect(screen.getByLabelText("Environment variable 1 name")).toHaveValue(
      "TOKEN"
    );
    expect(screen.getByLabelText("Environment variable 2 name")).toHaveValue(
      "LOG_LEVEL"
    );
    // ...while the values stay covered until an eye asks for one.
    expect(valueInput("1")).toHaveAttribute("type", "password");
    expect(valueInput("2")).toHaveAttribute("type", "password");
  });

  it("does not re-fire the fetch when it fails", () => {
    // The mask doubles as the retry, so a failed fetch leaves `hasStoredEnv`
    // set. Without the guard the effect would fire on every render.
    const onReveal = vi.fn();
    const { rerender } = render(
      <EnvVarsSection
        envVars={[]}
        showEnvVars
        onToggle={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onUpdate={vi.fn()}
        hasStoredEnv
        revealError="Couldn't reveal saved secrets."
        onReveal={onReveal}
      />
    );

    rerender(
      <EnvVarsSection
        envVars={[]}
        showEnvVars
        onToggle={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onUpdate={vi.fn()}
        hasStoredEnv
        revealError="Couldn't reveal saved secrets."
        onReveal={onReveal}
      />
    );

    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Reveal saved environment variables" })
    ).toBeInTheDocument();
  });
});
