import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import { OrganizationProjects } from "../OrganizationProjects";

function Location() {
  return <output>{useLocation().pathname}</output>;
}

it("opens the selected project from the organization Home", () => {
  render(
    <MemoryRouter initialEntries={["/p/ponmlkjihgfedcba/home"]}>
      <OrganizationProjects
        projects={[{ _id: "abcdefghijklmnop", name: "Team playground" }]}
      />
      <Location />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open project" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "/p/abcdefghijklmnop/servers",
  );
});
