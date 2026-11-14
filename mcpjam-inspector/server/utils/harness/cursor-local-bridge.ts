/**
 * Cursor's ACP bridge as a session on the member's computer runs it: the
 * hosted bridge exactly as `cursor-harness.ts` builds it, plus one change.
 *
 * The bridge starts the vendor CLI at `<implementation dir>/<executablePath>`.
 * In the cloud the adapter installs the CLI into that directory. Locally the
 * CLI is in the verified pack and the directory is the session's own, whose
 * `implementation.json` the runner writes, so an absolute `executablePath` is
 * used as it is. The layer bundler builds the layer's bridge from this recipe
 * (`scripts/bundle-local-harness-layer.mjs`).
 */
import { createCursorHarness } from "./cursor-harness.js";
import { replaceInRegion } from "./cursor-host-tool-approval.js";

const SPAWN = "child = spawn(`${implementationDir}/${implementation.executablePath}`,";
const LOCAL_SPAWN =
  "child = spawn(/^(?:\\/|[A-Za-z]:[\\\\/])/.test(implementation.executablePath) ? implementation.executablePath : " +
  "`${implementationDir}/${implementation.executablePath}`,";

/** The bridge source with the local launch change, or a refusal if the pinned bridge moved. */
export function patchCursorLocalLaunch(source: string): string {
  return replaceInRegion(source, "src/v1/bridge/index.ts", SPAWN, LOCAL_SPAWN);
}

/** The hosted recipe with the local launch change applied to its bridge. */
export async function localCursorBootstrapRecipe() {
  const harness = createCursorHarness({ auth: {}, mcpServers: {} });
  if (!harness.getBootstrap) throw new Error("the Cursor harness has no bootstrap recipe");
  const recipe = await harness.getBootstrap();
  const bridgePath = `${recipe.bootstrapDir}/bridge.mjs`;
  if (!recipe.files.some((file) => file.path === bridgePath)) throw new Error("the Cursor recipe has no bridge.mjs");
  return {
    ...recipe,
    files: recipe.files.map((file) =>
      file.path === bridgePath && typeof file.content === "string"
        ? { ...file, content: patchCursorLocalLaunch(file.content) }
        : file,
    ),
  };
}
