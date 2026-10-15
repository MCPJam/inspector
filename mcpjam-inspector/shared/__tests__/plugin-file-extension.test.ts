import { describe, expect, it } from "vitest";
import {
  pluginFileEntrypointPlan,
  pluginFileNameMatchesExtension,
} from "../plugin-file";

const viewer = {
  name: "cad.viewer",
  inputSchema: { type: "object" as const },
  _meta: {
    ui: { resourceUri: "ui://cad/viewer" },
    "openai/ui": { entrypoints: [{ type: "file", extensions: [".stl"] }] },
  },
};
describe("file viewer extension matching", () => {
  it("matches declared extensions case-insensitively, like HTML accept", () => {
    expect(pluginFileNameMatchesExtension("PART.STL", ".stl")).toBe(true);
    expect(pluginFileNameMatchesExtension("part.stl", ".STL")).toBe(true);
    expect(pluginFileNameMatchesExtension("part.stl.txt", ".stl")).toBe(false);
  });
  it("opens an upper-case file name with its viewer", () => {
    const plan = (name: string) =>
      pluginFileEntrypointPlan(viewer as never, {
        file: { name, resourceUri: "host-resource://abc" },
      });
    expect(plan("PART.STL").params.name).toBe("cad.viewer");
    expect(() => plan("part.step")).toThrow();
  });
});
