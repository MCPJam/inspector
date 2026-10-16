import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionTargetChip } from "../execution-target-chip";

afterEach(cleanup);

describe("read-only execution venue", () => {
  it.each([
    ["hosted", "ready", "Cloud"],
    ["local-native", "ready", "This machine"],
    [null, "loading", "Checking…"],
    [null, "unavailable", "Unavailable"],
  ] as const)(
    "shows %s/%s without offering a control",
    (target, phase, label) => {
      render(
        <ExecutionTargetChip
          readOnly
          target={target}
          phase={phase}
          hostedAvailable={true}
          harnessName="Codex"
        />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(label);
      expect(screen.queryByRole("button")).toBeNull();
    },
  );
});
