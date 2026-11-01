/**
 * Imported for its effect by the SDK main entry, which runs only in Node. It
 * hands code shared with the browser bundles (the model lease and the model
 * factory) the resolver that also reads the IT settings file and its lock, so
 * `createModelFromString` from `@mcpjam/sdk` honors the lock too.
 */
import { registerDeploymentResolver } from "./address.js";
import { resolveDeployment } from "./resolve.js";

registerDeploymentResolver(
  (explicit) =>
    resolveDeployment({ baseUrl: explicit, credential: "api-key" }).baseUrl
);
