import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { EnvVarsSection } from "../shared/EnvVarsSection";

type EnvVar = { key: string; value: string };

function valueInput(name: string) {
  return screen.getByLabelText(`Environment variable ${name} value`);
}

const HIDDEN_MASK = "••••••••••••";

/** A covered row shows a fixed twelve dots whatever it holds, so the mask never
 * encodes the length of the value under it, and is read-only because the box is
 * showing a decoy. */
function expectMasked(input: HTMLElement) {
  expect(input).toHaveValue(HIDDEN_MASK);
  expect(input).toHaveAttribute("readonly");
}

function expectUncovered(input: HTMLElement, value: string) {
  expect(input).toHaveValue(value);
  expect(input).not.toHaveAttribute("readonly");
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

    // Twelve dots for a fourteen-character key: the mask is the same width
    // whatever it covers.
    expectMasked(valueInput("1"));

    await user.click(
      screen.getByRole("button", { name: "Show value for OPENAI_API_KEY" })
    );
    expectUncovered(valueInput("1"), "sk-proj-secret");

    await user.click(
      screen.getByRole("button", { name: "Hide value for OPENAI_API_KEY" })
    );
    expectMasked(valueInput("1"));
  });

  it("masks a long and a short value to the same width", () => {
    render(
      <Harness
        initial={[
          { key: "SHORT", value: "ab" },
          { key: "LONG", value: "sk-proj-aVeryLongSecretIndeed-0123456789" },
        ]}
      />
    );

    expect(valueInput("1")).toHaveValue(valueInput("2").getAttribute("value"));
    expectMasked(valueInput("1"));
    expectMasked(valueInput("2"));
  });

  it("refuses edits while a value is covered", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(
      <EnvVarsSection
        envVars={[{ key: "TOKEN", value: "secret" }]}
        showEnvVars
        onToggle={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onUpdate={onUpdate}
      />
    );

    // The box is showing a decoy, so keystrokes must not reach `onUpdate` —
    // they would write the mask back over the real value.
    await user.type(valueInput("1"), "xyz");

    expect(onUpdate).not.toHaveBeenCalled();
    expectMasked(valueInput("1"));
  });

  it("leaves a newly added row unmasked so it can be typed into", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Add variable" }));

    expectUncovered(valueInput("1"), "");
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

    expectMasked(valueInput("1"));
    expectUncovered(valueInput("2"), "three");
    expect(
      screen.getByRole("button", { name: "Hide value for THIRD" })
    ).toBeInTheDocument();
  });

  it("does not fetch stored values just because the section is open", () => {
    // `onReveal` decrypts the server's whole secret set, so expanding the
    // disclosure must not fire it — only the mask may.
    const onReveal = vi.fn();
    render(
      <EnvVarsSection
        envVars={[]}
        showEnvVars
        onToggle={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onUpdate={vi.fn()}
        hasStoredEnv
        onReveal={onReveal}
      />
    );

    expect(onReveal).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Reveal saved environment variables" })
    ).toBeInTheDocument();
  });

  it("names the rows on reveal without unmasking them", async () => {
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
          hasStoredEnv={envVars.length === 0}
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

    await user.click(
      screen.getByRole("button", { name: "Reveal saved environment variables" })
    );

    // One click buys both halves: which variables are set, so the keys are
    // readable...
    expect(screen.getByLabelText("Environment variable 1 name")).toHaveValue(
      "TOKEN"
    );
    expect(screen.getByLabelText("Environment variable 2 name")).toHaveValue(
      "LOG_LEVEL"
    );
    // ...while the values stay covered until an eye asks for one.
    expectMasked(valueInput("1"));
    expectMasked(valueInput("2"));
  });
});
