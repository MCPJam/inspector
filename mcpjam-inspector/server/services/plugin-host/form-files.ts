import { HOSTED_MODE } from "../../config.js";
import { PluginInvocationError, withPluginDiagnostic } from "./invocation.js";
import {
  createPluginFormAuthority,
  type PluginFormServiceOptions,
} from "./form-service.js";
import {
  pluginFormFileGrants,
  formUploadInput,
  type PluginFormUploadFile,
} from "./form-file-grants.js";
import {
  createProjectComputerConnector,
  type ComputerFileSystem,
} from "./computer-file-target.js";
import { createComputerFormFileStore } from "./computer-form-files.js";
import type { PluginFormSource } from "./form-sources.js";
import type { ExecutionScope } from "../../utils/execution-scope.js";

type PluginFormSourceUploadTarget = PluginFormSource["uploadTarget"];
/** Connectors for the project's Computer (hosted uploads). Replaced in tests. */
export const pluginComputerUploads = {
  connector: (serverId: string) => createProjectComputerConnector(serverId),
};

/** Transport eligibility only; the immutable source also needs namespace opt-in. */
export function isLocalPluginFormFileTarget(config: unknown) {
  return (
    !HOSTED_MODE &&
    !!config &&
    typeof config === "object" &&
    "command" in config &&
    typeof config.command === "string" &&
    !!config.command.trim()
  );
}
/** The upload target the source was elicited with is still available now. */
function uploadsAvailable(
  target: PluginFormSourceUploadTarget,
  current: { manager: { getServerConfig(id: string): unknown }; computerUploads?: boolean },
  serverId: string,
) {
  return target === "local-stdio"
    ? isLocalPluginFormFileTarget(current.manager.getServerConfig(serverId))
    : target === "computer"
      ? current.computerUploads === true
      : false;
}
/** The client's CURRENT toggles allow this upload. Capability toggles are
 * outside the instance binding, so every upload re-checks them against the
 * same fresh admission read that authorized it: Forms off takes no uploads,
 * and a form asked for through an MCP App takes none once File resources is
 * off (the spec's web rule). A server's own form doesn't depend on it. */
function assertUploadToggles(
  source: PluginFormSource,
  current: { extensions?: { capabilities: { forms?: boolean; fileResources?: boolean } } },
) {
  const capabilities = current.extensions?.capabilities;
  if (!capabilities) return;
  if (capabilities.forms === false)
    throw withPluginDiagnostic(
      new PluginInvocationError("PLUGIN_FORMS_DISABLED"),
      source.owner.serverId,
      "Upload refused: Forms is turned off for this client",
    );
  if (source.origin === "app" && capabilities.fileResources === false)
    throw withPluginDiagnostic(
      new PluginInvocationError("PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED"),
      source.owner.serverId,
      "Upload refused: File resources is turned off for this client",
    );
}
function fileAuthority(options: PluginFormServiceOptions) {
  const service = createPluginFormAuthority(options);
  let scope: ExecutionScope | undefined;
  const authorize = async () => {
    const current = await service.authorize();
    assertUploadToggles(service.source, current);
    if (
      !uploadsAvailable(
        service.source.uploadTarget,
        current,
        service.source.owner.serverId,
      )
    )
      throw new PluginInvocationError("FORM_FILE_UNAVAILABLE");
    scope = current.executionScope;
    return current;
  };
  return { ...service, authorize, executionScope: () => scope };
}
export async function describePluginFormFiles(
  options: PluginFormServiceOptions,
) {
  const service = createPluginFormAuthority(options);
  try {
    const current = await service.authorize();
    const available = uploadsAvailable(
      service.source.uploadTarget,
      current,
      service.source.owner.serverId,
    );
    return {
      userResources: available,
      userResourceKinds: available
        ? ["file" as const, "directory" as const]
        : [],
      // The client compiles the form with the same File resources rule the
      // server applies, so it refuses what the server would refuse.
      origin:
        service.source.origin === "app"
          ? ("mcp-app" as const)
          : ("server" as const),
      fileResources: service.source.fileResources === true,
    };
  } finally {
    await service.runtime.release();
  }
}
export async function uploadPluginFormFiles(
  options: PluginFormServiceOptions & {
    field: string;
    operationId: string;
    files: PluginFormUploadFile[];
  },
) {
  const service = fileAuthority(options);
  try {
    formUploadInput(service.source, options.field);
    // On the project's Computer the bytes go to the VM through this
    // request's own connection, made only after authorization.
    let connection: Promise<ComputerFileSystem> | undefined;
    const store =
      service.source.uploadTarget === "computer"
        ? createComputerFormFileStore(() =>
            (connection ??= pluginComputerUploads.connector(
              service.source.owner.serverId,
            )({
              bearer: options.bearer,
              projectId: options.actor.projectId,
              executionScope: service.executionScope(),
              signal: service.signal,
            })),
          )
        : undefined;
    return await pluginFormFileGrants.upload({
      source: service.source,
      token: options.sourceToken,
      field: options.field,
      operationId: options.operationId,
      files: options.files,
      sourceSignal: service.sourceSignal,
      signal: service.signal,
      authorize: service.authorize,
      ...(store ? { store } : {}),
    });
  } finally {
    await service.runtime.release();
  }
}
