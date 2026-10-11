import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PluginFormFields, type PluginFormPorts } from "../PluginFormFields";
import {
  compilePluginForm,
  initialPluginFormValues,
  pluginFormThumbnailSource,
  type PluginFormProfile,
} from "@/shared/plugin-extensions/form-plan";

const profile: PluginFormProfile = {
  fileResources: true,
  origin: "server",
  userResources: false,
  previews: false,
};

/** Controlled harness that exposes the current values for assertions. */
function Harness({
  schema,
  ports,
  formProfile = profile,
  onValues,
}: {
  schema: unknown;
  ports?: PluginFormPorts;
  formProfile?: PluginFormProfile;
  onValues?: (values: Record<string, unknown>) => void;
}) {
  const [plan] = useState(() => compilePluginForm(schema, formProfile));
  const [values, setValues] = useState(() => initialPluginFormValues(plan));
  return (
    <PluginFormFields
      requestId="rows"
      plan={plan}
      values={values}
      errors={{}}
      ports={ports}
      onChange={(name, value) =>
        setValues((old) => {
          const next = { ...old, [name]: value };
          onValues?.(next);
          return next;
        })
      }
    />
  );
}

describe("shared choice rows", () => {
  it("numbers single choices and checks multi-select rows", () => {
    const values = vi.fn();
    render(
      <Harness
        onValues={values}
        schema={{
          type: "object",
          properties: {
            size: {
              type: "string",
              title: "Size",
              oneOf: [
                { const: "s", title: "Small", description: "Fits a 1U cap" },
                { const: "m", title: "Medium" },
              ],
            },
            checks: {
              type: "array",
              title: "Checks",
              items: {
                anyOf: [
                  { const: "fit", title: "Clearance" },
                  { const: "dims", title: "Dimensions" },
                ],
              },
            },
          },
        }}
      />,
    );
    const small = screen.getByRole("radio", {
      name: "Small Fits a 1U cap",
    });
    expect(small).toHaveTextContent("1");
    expect(small).toHaveAttribute("data-choice-key", "1");
    fireEvent.click(screen.getByRole("radio", { name: "Medium" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Dimensions" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Clearance" }));
    expect(values).toHaveBeenLastCalledWith({
      size: "m",
      checks: ["dims", "fit"],
    });
    expect(screen.queryByText(/Offered choices|Add value/)).toBeNull();
  });

  it("lets a single text answer use a suggestion or the user's own words", () => {
    const values = vi.fn();
    render(
      <Harness
        onValues={values}
        schema={{
          type: "object",
          properties: {
            finish: {
              type: "string",
              title: "Finish",
              pattern: "^[a-z ]+$",
              "x-openai-suggestions": [
                { const: "matte", title: "Matte" },
                { const: "gloss", title: "Gloss" },
              ],
            },
          },
        }}
      />,
    );
    // No raw pattern text in the form.
    expect(screen.queryByText(/\^\[a-z/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Gloss" }));
    expect(values).toHaveBeenLastCalledWith({ finish: "gloss" });
    fireEvent.change(screen.getByRole("textbox", { name: "Other Finish" }), {
      target: { value: "satin" },
    });
    expect(values).toHaveBeenLastCalledWith({ finish: "satin" });
    expect(screen.getByRole("radio", { name: "Gloss" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("keeps typed entries as checked rows and removes exactly the one unchecked", () => {
    const values = vi.fn();
    render(
      <Harness
        onValues={values}
        schema={{
          type: "object",
          properties: {
            tags: {
              type: "array",
              title: "Tags",
              items: {
                type: "string",
                "x-openai-suggestions": [{ const: "abs", title: "ABS" }],
              },
            },
          },
        }}
      />,
    );
    const add = screen.getByRole("textbox", { name: "Add Tags" });
    for (const tag of ["pla", "pla"]) {
      fireEvent.change(add, { target: { value: tag } });
      fireEvent.keyDown(add, { key: "Enter" });
    }
    fireEvent.click(screen.getByRole("checkbox", { name: "ABS" }));
    expect(values).toHaveBeenLastCalledWith({ tags: ["pla", "pla", "abs"] });
    // A checked suggestion is not repeated as a typed row.
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    const typed = screen.getAllByRole("checkbox", { name: "pla" });
    expect(typed).toHaveLength(2);
    fireEvent.click(typed[1]!);
    expect(values).toHaveBeenLastCalledWith({ tags: ["pla", "abs"] });
  });

  it("labels a boolean by its title instead of Enabled/Disabled", () => {
    const values = vi.fn();
    render(
      <Harness
        onValues={values}
        schema={{
          type: "object",
          properties: {
            notify: { type: "boolean", title: "Email me when it ships" },
          },
        }}
      />,
    );
    expect(screen.queryByText(/Enabled|Disabled/)).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Email me when it ships" }),
    );
    expect(values).toHaveBeenLastCalledWith({ notify: true });
  });

  it("lays resources out as cards with uploads first, allowed types, previews and View all", async () => {
    const preview = vi.fn(async () => ({
      content: <p>Preview body</p>,
      release: vi.fn(),
    }));
    const chooseResources = vi.fn(async () => ["file://added.stl"]);
    const options = ["one", "two", "three", "four"].map((key) => ({
      uri: `fixture://${key}`,
      name: key,
      title: `Part ${key}`,
      _meta: {
        "openai/thumbnail": { src: `https://example.test/${key}.png` },
        ...(key === "two"
          ? {
              "openai/preview": {
                target: {
                  type: "resource_link",
                  uri: "fixture://two",
                  name: "two",
                },
              },
            }
          : {}),
      },
    }));
    const values = vi.fn();
    render(
      <Harness
        onValues={values}
        formProfile={{ ...profile, userResources: true, previews: true }}
        ports={{
          preview,
          chooseResources,
          resourceLabel: (uri) =>
            uri === "file://added.stl" ? "added.stl" : uri,
        }}
        schema={{
          type: "object",
          properties: {
            refs: {
              type: "array",
              title: "CAD references",
              items: { type: "string", format: "uri" },
              "x-openai-input": {
                type: "resource",
                options,
                userOptions: {
                  kind: "file",
                  accept: [".stl", ".3mf", ".step"],
                },
              },
            },
          },
        }}
      />,
    );
    expect(
      screen.getByText("Allowed file types: .stl, .3mf, or .step"),
    ).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "CAD references" });
    // "Choose files" leads the row.
    expect(group.firstElementChild).toHaveTextContent("Choose files");
    expect(group.querySelectorAll('[data-thumbnail="card"]')).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: /^Preview / })).toHaveLength(
      1,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Part three" }));
    expect(values).toHaveBeenLastCalledWith({ refs: ["fixture://three"] });

    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    expect(group.className).toContain("grid");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));

    fireEvent.click(screen.getByRole("button", { name: "Preview Part two" }));
    expect(await screen.findByText("Preview body")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

    fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    await waitFor(() =>
      expect(values).toHaveBeenLastCalledWith({
        refs: ["fixture://three", "file://added.stl"],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove added.stl" }));
    expect(values).toHaveBeenLastCalledWith({ refs: ["fixture://three"] });
  });
});

describe("form author hints", () => {
  it("flags partial thumbnails and thumbnails that aren't HTTPS or data images", () => {
    const plan = compilePluginForm(
      {
        type: "object",
        properties: {
          part: {
            type: "string",
            oneOf: [
              {
                const: "a",
                title: "A",
                "x-openai-thumbnail": { src: "http://insecure.test/a.png" },
              },
              { const: "b", title: "B" },
            ],
          },
          ok: {
            type: "string",
            oneOf: [
              {
                const: "c",
                title: "C",
                "x-openai-thumbnail": { src: "data:image/png;base64,AAAA" },
              },
            ],
          },
        },
      },
      profile,
    );
    expect(plan.diagnostics?.map((item) => item.code)).toEqual([
      "PLUGIN_FORM_THUMBNAIL_SOURCE_INVALID",
      "PLUGIN_FORM_THUMBNAIL_PARTIAL",
    ]);
  });
});

describe("thumbnails", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  it.each([
    [{ src: "https://cdn.example.test/a.png" }, true],
    [{ src: "HTTPS://cdn.example.test/a.png" }, true],
    [{ src: png, mimeType: "image/png", sizes: ["48x48"] }, true],
    [{ src: "https://cdn.example.test/a.svg", theme: "dark" }, true],
    [{ src: "http://cdn.example.test/a.png" }, false],
    [{ src: "https://user:pw@cdn.example.test/a.png" }, false],
    [{ src: "data:image/png,rawbytes" }, false],
    [{ src: "data:text/html;base64,PGI+" }, false],
    [{ src: "https://cdn.example.test/a", mimeType: "text/html" }, false],
    ["https://cdn.example.test/a.png", false],
  ])("loads %j: %s", (icon, loads) => {
    expect(!!pluginFormThumbnailSource(icon)).toBe(loads);
  });

  it("gives every option of a field the image layout, with fallbacks", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: {
            part: {
              type: "string",
              title: "Part",
              oneOf: [
                {
                  const: "bolt",
                  title: "Bolt",
                  "x-openai-thumbnail": {
                    src: "https://cdn.example.test/bolt.png",
                    theme: "dark",
                  },
                },
                {
                  const: "nut",
                  title: "Nut",
                  "x-openai-thumbnail": { src: "http://cdn.example.test/n.png" },
                },
                { const: "washer", title: "Washer" },
              ],
            },
          },
        }}
      />,
    );
    const rows = document.querySelectorAll('[data-thumbnail="row"]');
    expect(rows).toHaveLength(3);
    // A single thumbnail is shown whatever its theme; an insecure one and a
    // missing one both get the fallback image.
    expect(rows[0]!.querySelector("img")).toHaveAttribute(
      "src",
      "https://cdn.example.test/bolt.png",
    );
    expect(rows[1]!.querySelector("img")).toBeNull();
    expect(rows[2]!.querySelector("img")).toBeNull();
  });

  it("logs resource option thumbnails by the same rules", () => {
    const plan = compilePluginForm(
      {
        type: "object",
        properties: {
          part: {
            type: "string",
            format: "uri",
            "x-openai-input": {
              type: "resource",
              options: [
                {
                  uri: "fixture://a",
                  name: "a",
                  _meta: {
                    "openai/thumbnail": { src: "http://insecure.test/a.png" },
                  },
                },
                { uri: "fixture://b", name: "b" },
              ],
            },
          },
        },
      },
      profile,
    );
    expect(plan.diagnostics?.map((item) => item.code)).toEqual([
      "PLUGIN_FORM_THUMBNAIL_SOURCE_INVALID",
      "PLUGIN_FORM_THUMBNAIL_PARTIAL",
    ]);
    expect(plan.diagnostics?.[0]?.details).toMatchObject({
      field: "part",
      options: ["a"],
    });
  });
});

describe("resource selection modes", () => {
  const options = ["bolt", "washer"].map((key) => ({
    uri: `cad://parts/${key}`,
    name: key,
    title: `M6 ${key}`,
  }));
  const field = (input: Record<string, unknown>, type = "array") => ({
    type: "object",
    properties: {
      parts: {
        type,
        title: "Parts",
        ...(type === "array"
          ? { items: { type: "string", format: "uri" } }
          : { format: "uri" }),
        "x-openai-input": { type: "resource", options, ...input },
      },
    },
  });

  it("implicit: starts with every option, removes instead of unchecking, and adds files", async () => {
    const values = vi.fn();
    const chooseResources = vi.fn(async () => ["file:///spacer.stl"]);
    render(
      <Harness
        onValues={values}
        formProfile={{ ...profile, userResources: true }}
        ports={{ chooseResources }}
        schema={field({ selection: "implicit" })}
      />,
    );
    // Nothing to select or deselect: every remaining item is included.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Remove M6 bolt" }));
    expect(values).toHaveBeenLastCalledWith({ parts: ["cad://parts/washer"] });
    expect(screen.queryByText("M6 bolt")).toBeNull();
    // Uploads are always allowed, any file type, when userOptions is omitted.
    fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    await waitFor(() =>
      expect(values).toHaveBeenLastCalledWith({
        parts: ["cad://parts/washer", "file:///spacer.stl"],
      }),
    );
    expect(chooseResources.mock.calls[0]![0]).toEqual({ kind: "file" });
  });

  it("explicit: selects and deselects, with no upload input when userOptions is omitted", () => {
    const values = vi.fn();
    render(
      <Harness
        onValues={values}
        formProfile={{ ...profile, userResources: true }}
        ports={{ chooseResources: vi.fn() }}
        schema={field({ selection: "explicit" })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Choose files" })).toBeNull();
    const bolt = screen.getByRole("checkbox", { name: "M6 bolt" });
    fireEvent.click(bolt);
    expect(values).toHaveBeenLastCalledWith({ parts: ["cad://parts/bolt"] });
    fireEvent.click(bolt);
    expect(values).toHaveBeenLastCalledWith({ parts: [] });
    // Deselected options stay offered.
    expect(screen.getByRole("checkbox", { name: "M6 bolt" })).toBeVisible();
  });

  it("single: one URI, from an option or an upload of the declared kind", async () => {
    const values = vi.fn();
    const chooseResources = vi.fn(async () => ["file:///cad"]);
    render(
      <Harness
        onValues={values}
        formProfile={{ ...profile, userResources: true }}
        ports={{ chooseResources }}
        schema={field(
          { userOptions: { kind: "directory", accept: [".stl"] } },
          "string",
        )}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "M6 washer" }));
    expect(values).toHaveBeenLastCalledWith({ parts: "cad://parts/washer" });
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() =>
      expect(values).toHaveBeenLastCalledWith({ parts: "file:///cad" }),
    );
    expect(chooseResources.mock.calls[0]![0]).toEqual({
      kind: "directory",
      accept: [".stl"],
    });
    expect(chooseResources.mock.calls[0]![2]).toEqual({
      field: "parts",
      multiple: false,
    });
  });
});
