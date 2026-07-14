import { describe, expect, it } from "vitest";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = join(here, "..");

// The XML/DSig stack is Node-only credential machinery. If any of it ever
// becomes reachable from the browser entry, the bundle both bloats and drags
// crypto into the client — and `test:packaging` cannot catch it (it imports
// `@mcpjam/sdk/browser` in Node, where xml-crypto resolves fine). A dist
// string-grep can also miss renamed bundled code, so this asserts on the
// actual import graph esbuild resolves from src/browser.ts.
const FORBIDDEN_MODULES = [/^xml-crypto(\/|$)/, /^@xmldom\//, /^xpath(\/|$)/];

describe("browser entry import graph", () => {
  it("never reaches xml-crypto/@xmldom/xpath (or any node_modules code)", async () => {
    // Externalize every bare import while RECORDING it: the metafile then
    // contains the complete first-party module graph, and `bareImports` the
    // complete set of package specifiers that graph pulls in.
    const bareImports = new Set<string>();
    const result = await build({
      entryPoints: [join(sdkRoot, "src", "browser.ts")],
      bundle: true,
      write: false,
      metafile: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      logLevel: "silent",
      loader: { ".md": "text" },
      plugins: [
        {
          name: "record-and-externalize-bare-imports",
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
              // The entry point can match this bare-path filter on Windows
              // (absolute paths like `C:\...`). Externalizing it would yield an
              // empty bundle and fail the non-vacuity assertion below, so let
              // esbuild resolve entry points normally.
              if (args.kind === "entry-point") return null;
              bareImports.add(args.path);
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });

    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.length).toBeGreaterThan(0);
    // Sanity: the graph actually walked into the XAA browser-safe modules —
    // otherwise a green run proves nothing.
    const normalized = inputs.map((input) =>
      relative(sdkRoot, join(sdkRoot, input)).split(sep).join("/")
    );
    expect(normalized).toContain("src/xaa/constants.ts");

    // No first-party file from the Node-only mint XML stack.
    const samlSources = normalized.filter((input) =>
      input.includes("src/xaa/mint/saml")
    );
    expect(samlSources).toEqual([]);

    // No forbidden package anywhere in the graph's bare imports.
    const forbidden = [...bareImports].filter((specifier) =>
      FORBIDDEN_MODULES.some((pattern) => pattern.test(specifier))
    );
    expect(forbidden).toEqual([]);

    // Belt and braces: nothing under node_modules was inlined either (bare
    // imports are externalized above, so any hit means a resolution leak).
    expect(
      normalized.filter((input) => input.includes("node_modules"))
    ).toEqual([]);
  });
});
