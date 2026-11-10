import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PluginFormFields } from "../PluginFormFields";
import { FormChoiceGroup } from "../FormChoiceGroup";
import { compilePluginForm } from "@/shared/plugin-extensions/form-plan";

const schema = {
  type: "object",
  properties: {
    size: { type: "string", title: "Size", enum: ["Small", "Medium", "Large"] },
    part: {
      type: "string", title: "Part", format: "uri",
      "x-openai-input": { type: "resource", options: [
        { uri: "fixture://bolt", name: "Bolt" },
        { uri: "fixture://washer", name: "Washer" },
      ] },
    },
    checks: { type: "array", title: "Checks", items: { type: "string", enum: ["Fit", "Finish"] } },
  },
};
const plan = compilePluginForm(schema, {
  fileResources: true, origin: "server", userResources: false, previews: false,
});
function Harness({ disabled = false }: { disabled?: boolean }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  return <>
    <button>Before</button>
    <PluginFormFields requestId="keyboard" plan={plan} values={values} errors={{}}
      disabled={disabled} onChange={(key, value) => setValues(old => ({ ...old, [key]: value }))} />
    <button>After</button>
  </>;
}

describe("plugin form radio keyboard navigation", () => {
  it("wraps arrow selection and focus without changing another group", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const sizes = within(screen.getByRole("radiogroup", { name: "Size" }));
    const parts = within(screen.getByRole("radiogroup", { name: "Part" }));
    const small = sizes.getByRole("radio", { name: "Small" });
    const medium = sizes.getByRole("radio", { name: "Medium" });
    const large = sizes.getByRole("radio", { name: "Large" });
    await user.tab(); await user.tab();
    expect(small).toHaveFocus();
    expect(small).toHaveAttribute("aria-checked", "false");
    await user.keyboard("{ArrowDown}");
    expect(medium).toHaveFocus();
    expect(medium).toHaveAttribute("aria-checked", "true");
    await user.tab();
    expect(parts.getByRole("radio", { name: "Bolt" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(medium).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowLeft}");
    expect(large).toHaveFocus();
    expect(large).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowRight}");
    expect(small).toHaveFocus();
    expect(small).toHaveAttribute("aria-checked", "true");
    expect(parts.getAllByRole("radio").every(radio => radio.getAttribute("aria-checked") === "false")).toBe(true);
    await user.tab();
    expect(parts.getByRole("radio", { name: "Bolt" })).toHaveFocus();
    await user.keyboard(" ");
    expect(parts.getByRole("radio", { name: "Bolt" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowLeft}");
    expect(parts.getByRole("radio", { name: "Washer" })).toHaveFocus();
    expect(parts.getByRole("radio", { name: "Washer" })).toHaveAttribute("aria-checked", "true");
    expect(small).toHaveAttribute("aria-checked", "true");
    await user.tab({ shift: true });
    expect(small).toHaveFocus();
  });

  it("skips disabled radios and does not deselect the sole enabled radio", async () => {
    function DisabledChoices({ onlyFirst = false }: { onlyFirst?: boolean }) {
      const [selected, select] = useState("A");
      return <FormChoiceGroup multiple={false} label="Disabled choices" className="">
        {["A", "B", "C"].map(value => <button key={value} role="radio"
          disabled={value === "B" || (onlyFirst && value !== "A")}
          aria-checked={selected === value} onClick={() => select(selected === value ? "" : value)}>{value}</button>)}
      </FormChoiceGroup>;
    }
    const user = userEvent.setup();
    const view = render(<DisabledChoices />);
    const a = screen.getByRole("radio", { name: "A" });
    const b = screen.getByRole("radio", { name: "B" });
    const c = screen.getByRole("radio", { name: "C" });
    a.focus(); await user.keyboard("{ArrowDown}");
    expect(c).toHaveFocus();
    expect(c).toHaveAttribute("aria-checked", "true");
    expect(b).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{ArrowDown}");
    expect(a).toHaveFocus();
    view.rerender(<DisabledChoices onlyFirst />);
    await user.keyboard("{ArrowLeft}");
    expect(a).toHaveFocus();
    expect(a).toHaveAttribute("aria-checked", "true");
  });

  it("leaves checkbox Tab and Space behavior unchanged and skips disabled fields", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    const fit = screen.getByRole("checkbox", { name: "Fit" });
    const finish = screen.getByRole("checkbox", { name: "Finish" });
    fit.focus(); await user.keyboard(" ");
    expect(fit).toHaveAttribute("aria-checked", "true");
    await user.tab(); expect(finish).toHaveFocus();
    await user.keyboard(" ");
    expect(fit).toHaveAttribute("aria-checked", "true");
    expect(finish).toHaveAttribute("aria-checked", "true");
    view.rerender(<Harness disabled />);
    screen.getByRole("button", { name: "Before" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });
});
