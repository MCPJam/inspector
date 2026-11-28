/**
 * OpenCode's bridge as a session on the member's computer runs it: the
 * adapter's bridge exactly as hosted OpenCode runs it, plus the local launch
 * changes. The layer bundler builds the layer's bridge and host-tool MCP
 * entrypoint from this recipe (`scripts/bundle-local-harness-layer.mjs`).
 *
 * In the cloud everything sits in one bootstrap directory: the CLI under
 * `node_modules/.bin`, and the host-tool entrypoint beside the bridge, which
 * OpenCode starts with whatever `node` is on PATH. Locally that directory is
 * split between the verified pack and the Inspector layer, and PATH holds only
 * the system's directories, so the translator names both halves
 * (`--vendor-dir`, `--layer-dir`) and the bridge:
 *
 *  - puts the pack's own OpenCode build on PATH, where the SDK starts
 *    `opencode serve`, with ripgrep after it as before;
 *  - starts the host-tool entrypoint from the layer with the pack's Node,
 *    the one running the bridge.
 *
 * Nothing else changes: OpenCode's own configuration, permissions and network
 * use are what hosted OpenCode runs with.
 */
import { createOpenCode } from "@ai-sdk/harness-opencode";
import { replaceInRegion } from "./bridge-source-patch.js";

const BRIDGE_REGION = "src/bridge/index.ts";

const CONFIGURE_PATH = `configureOpenCodePath({
	bootstrapDir,
	env
});`;
const LOCAL_CONFIGURE_PATH = `const mcpjamLayerDir = (() => {
	const flag = (name) => {
		const at = argv.indexOf(name);
		return at >= 0 && at + 1 < argv.length ? argv[at + 1] : void 0;
	};
	const vendorDir = flag("--vendor-dir");
	const layerDir = flag("--layer-dir");
	if (!vendorDir || !layerDir) emitFatal("Missing --vendor-dir or --layer-dir argument.");
	const build = \`opencode-\${process.platform === "win32" ? "windows" : process.platform}-\${process.arch}\`;
	env.PATH = [path.join(vendorDir, "node_modules", build, "bin"), env.PATH || fallbackPath, path.dirname(rgPath)].join(path.delimiter);
	return layerDir;
})();`;

const HOST_TOOL_COMMAND = 'command: ["node", `${bootstrapDir}/host-tool-mcp.mjs`],';
const LOCAL_HOST_TOOL_COMMAND = "command: [process.execPath, `${mcpjamLayerDir}/host-tool-mcp.mjs`],";

/** The bridge source with the local launch changes, or a refusal if the pinned bridge moved. */
export function patchOpenCodeLocalLaunch(source: string): string {
  const located = replaceInRegion(source, BRIDGE_REGION, CONFIGURE_PATH, LOCAL_CONFIGURE_PATH);
  return replaceInRegion(located, BRIDGE_REGION, HOST_TOOL_COMMAND, LOCAL_HOST_TOOL_COMMAND);
}

/** The hosted recipe with the local launch changes applied to its bridge. */
export async function localOpenCodeBootstrapRecipe() {
  const harness = createOpenCode();
  if (!harness.getBootstrap) throw new Error("the OpenCode harness has no bootstrap recipe");
  const recipe = await harness.getBootstrap();
  const bridgePath = `${recipe.bootstrapDir}/bridge.mjs`;
  if (!recipe.files.some((file) => file.path === bridgePath)) throw new Error("the OpenCode recipe has no bridge.mjs");
  return {
    ...recipe,
    files: recipe.files.map((file) =>
      file.path === bridgePath && typeof file.content === "string"
        ? { ...file, content: patchOpenCodeLocalLaunch(file.content) }
        : file,
    ),
  };
}
