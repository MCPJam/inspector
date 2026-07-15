import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComputersUnavailableMessage } from "../ComputersUnavailableMessage";

describe("ComputersUnavailableMessage", () => {
  it("names the situation without instructing users to set env vars", () => {
    const text =
      render(<ComputersUnavailableMessage />).container.textContent ?? "";
    expect(text).toMatch(/Computers aren't available here/i);
    expect(text).toMatch(/hasn't enabled Project Computers/i);
    // The old copy told everyone (including OSS users who can't act on it) to
    // set server env vars — that guidance must never come back.
    expect(text).not.toMatch(/COMPUTERS_/);
    expect(text).not.toMatch(/env/i);
    expect(text).not.toMatch(/\bset\b/i);
  });
});
