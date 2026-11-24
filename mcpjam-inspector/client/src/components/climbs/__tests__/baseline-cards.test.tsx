import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BaselineCards } from "../baseline-cards";
import { makeClimb } from "./fixtures";

const labels = { env_a: "A", env_b: "B" };

describe("BaselineCards", () => {
  it("lists the cases that are new to the climb and says where they go", () => {
    const base = makeClimb();
    const climb = makeClimb({ groups: { ...base.groups, newCases: [{ key: "search-empty", tool: "search" }, { key: "fetch-404", tool: "fetch" }] } });
    render(<BaselineCards climb={climb} labels={labels} />);
    expect(screen.getByTestId("new-cases")).toHaveTextContent("search-empty, fetch-404");
    expect(screen.getByTestId("new-cases")).toHaveTextContent("join steering from the next round");
  });

  it("says nothing when the groups name every case", () => {
    render(<BaselineCards climb={makeClimb()} labels={labels} />);
    expect(screen.queryByTestId("new-cases")).not.toBeInTheDocument();
  });
});
