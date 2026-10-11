import { PluginInvocationError } from "./invocation.js";
import {
  describePluginError,
  pluginDiagnostic,
  type PluginDiagnostic,
} from "../../../shared/plugin-diagnostics.js";

/** A refusal that carries its plain description and a Logs diagnostic. */
export class PluginFileTargetRefusal extends PluginInvocationError {
  readonly diagnostics: PluginDiagnostic[];
  constructor(
    code: string,
    serverId: string,
    title: string,
    details?: Record<string, unknown>,
    readonly status: 400 | 403 | 503 = 403,
  ) {
    super(code);
    this.diagnostics = [
      {
        ...pluginDiagnostic(
          "error",
          code,
          title,
          describePluginError(code) ?? code,
          details,
        ),
        serverId,
      },
    ];
  }
}
