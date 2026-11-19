import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { OrganizationModelPicker } from "../OrganizationModelPicker";

it("filters the model list and selects a listed model", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <OrganizationModelPicker
      id="model"
      label="Model"
      value=""
      suggestions={["gpt-5.1", "gpt-5-mini"]}
      isAzure={false}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.type(screen.getByLabelText("Search Model"), "mini");
  expect(
    screen.queryByRole("option", { name: "gpt-5.1" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "gpt-5-mini" }));
  expect(onChange).toHaveBeenCalledWith("gpt-5-mini");
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

it("accepts an Azure deployment name that is not in the model list", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <OrganizationModelPicker
      id="model"
      label="Deployment"
      value=""
      suggestions={[]}
      isAzure
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "Deployment" }));
  await user.type(
    screen.getByPlaceholderText("Enter a deployment name"),
    "qa-deployment",
  );
  await user.click(screen.getByRole("option", { name: "Use qa-deployment" }));
  expect(onChange).toHaveBeenCalledWith("qa-deployment");
});
