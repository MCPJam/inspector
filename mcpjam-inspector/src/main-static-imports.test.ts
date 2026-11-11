import { build } from "esbuild";
import { resolve } from "path";
import { expect, it } from "vitest";

it("main.ts does not statically import server/config.ts", async () => {
  // GUARDRAIL (PLB-272). `server/config.ts` reads SERVER_PORT once, when it
  // loads. main.ts sets that port after probing for a free one and only then
  // imports the server dynamically. A static path to config.ts freezes the
  // default port, so on a fallback port the server refuses its own window.
  // The lifecycle test mocks too many server modules to see every such path.
  const { metafile } = await build({
    absWorkingDir: resolve(__dirname, ".."),
    entryPoints: ["src/main.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    alias: { "@/shared": "./shared" },
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "static-imports-only",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) =>
            args.kind === "dynamic-import"
              ? { path: args.path, external: true }
              : undefined,
          );
        },
      },
    ],
  });

  expect(Object.keys(metafile.inputs)).not.toContain("server/config.ts");
});
