import { describe, expect, it } from "vitest";
import { compilePluginForm, validatePluginFormContent } from "../form-plan";
import {
  extendedFormFixture,
  unsupportedMixedFormFixture,
} from "../testing/form-fixtures";
const profile = {
  fileResources: false,
  origin: "server",
  previews: true,
  userResources: false,
} as const;
describe("disposable form coverage supplement", () => {
  it("preserves thumbnails, descriptions, suggestions and typed constrained fields", () => {
    const plan = compilePluginForm(extendedFormFixture, profile);
    expect(plan.fields).toHaveLength(6);
    expect(plan.schema.properties.choice).toEqual(
      extendedFormFixture.properties.choice,
    );
    expect(
      validatePluginFormContent(plan, {
        choice: "bolt",
        count: 0,
        enabled: false,
      }).valid,
    ).toBe(true);
    expect(
      validatePluginFormContent(plan, {
        choice: "bolt",
        count: 0.5,
        enabled: false,
      }).valid,
    ).toBe(false);
    expect(
      validatePluginFormContent(plan, {
        choice: "bolt",
        count: 9,
        enabled: false,
      }).valid,
    ).toBe(false);
  });
  it("refuses the entire mixed form but keeps a form whose previews can't render", () => {
    expect(() =>
      compilePluginForm(unsupportedMixedFormFixture, profile),
    ).toThrow();
    const plan = compilePluginForm(extendedFormFixture, {
      ...profile,
      previews: false,
    });
    expect(plan.fields.length).toBeGreaterThan(0);
    expect(JSON.stringify(plan.schema)).not.toContain("openai/preview");
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warning",
        code: "PLUGIN_FORM_PREVIEW_DROPPED",
      }),
    );
  });
});
