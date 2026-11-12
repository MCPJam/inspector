import path from "node:path";
import { pluginFileEntrypoints } from "../../../shared/plugin-activation.js";
import { pluginFileNameMatchesExtension } from "../../../shared/plugin-file.js";
import {
  pluginIconMetadata,
  type PluginIconMetadata,
} from "../../../shared/plugin-icons.js";
import { assertPluginExtensionEnabled } from "./request-runtime.js";
import { refusePluginFileOpen } from "./file-targets.js";
import { resolveLocalFilePath } from "./local-file-target.js";
import { resolveListedFileResource } from "./listed-file-resource.js";
import {
  createComputerFileTargetAdapter,
  createProjectComputerConnector,
  resolveComputerFilePath,
  type ComputerFileSystem,
} from "./computer-file-target.js";
import type { createPluginRequestRuntime } from "./request-runtime.js";

/** The same bounded icon presentation for every file/entrypoint catalog. */
export function discoveryIcons(serverInfoIcons: unknown) {
  let budget = 512 * 1024;
  const take = (icons: PluginIconMetadata["toolIcons"]) =>
    icons.slice(0, 4).filter((icon) => {
      if (icon.src.length > budget) return false;
      budget -= icon.src.length;
      return true;
    });
  const serverIcons = take(pluginIconMetadata([], serverInfoIcons).serverIcons);
  return {
    serverIcons,
    toolIcons: (icons: unknown) =>
      take(pluginIconMetadata(icons, []).toolIcons),
  };
}

/** A path selects only a file in this owner's freshly admitted contract. */
export async function openOwnedLocalFile(input: {
  current: Awaited<
    ReturnType<ReturnType<typeof createPluginRequestRuntime>["catalog"]>
  >;
  actorId: string;
  projectId: string;
  serverId: string;
  bearer: string;
  path: string;
  signal: AbortSignal;
  connect?: (signal: AbortSignal) => Promise<ComputerFileSystem>;
  verify: () => Promise<void>;
}) {
  const { current, serverId, signal } = input;
  if (current.extensions) {
    assertPluginExtensionEnabled(current.extensions, "localFiles");
    assertPluginExtensionEnabled(current.extensions, "fileViewers");
  }
  const identity = {
    actorId: input.actorId,
    projectId: input.projectId,
    serverId,
  };
  if (!current.localFileTargetContract)
    refusePluginFileOpen(
      current.fileTargets ?? { placement: "local" },
      identity,
    );
  const onComputer = current.fileTargets?.placement === "computer";
  const target = (onComputer ? resolveComputerFilePath : resolveLocalFilePath)(
    current.localFileTargetContract,
    serverId,
    input.path,
  );
  if (!target)
    refusePluginFileOpen(
      { placement: onComputer ? "computer" : "local" },
      identity,
    );
  if (onComputer) {
    const files = await (
      input.connect ??
      ((active) =>
        createProjectComputerConnector(serverId)({
          bearer: input.bearer,
          projectId: input.projectId,
          executionScope: current.executionScope,
          signal: active,
        }))
    )(signal);
    await createComputerFileTargetAdapter(target, async () => files).check(
      signal,
    );
  }
  const file = await resolveListedFileResource(
    current.manager,
    serverId,
    target.uri,
    signal,
  );
  const icons = discoveryIcons(
    current.manager?.getInitializationInfo?.(serverId)?.serverVersion?.icons,
  );
  const entries = pluginFileEntrypoints(current.tools)
    .filter((entry) =>
      entry.extensions.some((extension) =>
        pluginFileNameMatchesExtension(
          path.basename(target.relativePath),
          extension,
        ),
      ),
    )
    .map((entry) => {
      const toolIcons = icons.toolIcons(
        current.tools.find((tool) => tool.name === entry.toolName)?.icons,
      );
      return toolIcons.length ? { ...entry, toolIcons } : entry;
    });
  await input.verify();
  signal.throwIfAborted();
  return {
    file,
    entries,
    ...(icons.serverIcons.length ? { serverIcons: icons.serverIcons } : {}),
  };
}
