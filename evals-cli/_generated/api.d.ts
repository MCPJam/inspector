/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as apiKeys from "../apiKeys.js";
import type * as evals_helpers from "../evals/helpers.js";
import type * as evals_routes from "../evals/routes.js";
import type * as evals_run from "../evals/run.js";
import type * as evals_validation from "../evals/validation.js";
import type * as forwarding_helpers from "../forwarding/helpers.js";
import type * as forwarding_routes from "../forwarding/routes.js";
import type * as http from "../http.js";
import type * as lib_keys from "../lib/keys.js";
import type * as usage_create from "../usage/create.js";
import type * as users from "../users.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  apiKeys: typeof apiKeys;
  "evals/helpers": typeof evals_helpers;
  "evals/routes": typeof evals_routes;
  "evals/run": typeof evals_run;
  "evals/validation": typeof evals_validation;
  "forwarding/helpers": typeof forwarding_helpers;
  "forwarding/routes": typeof forwarding_routes;
  http: typeof http;
  "lib/keys": typeof lib_keys;
  "usage/create": typeof usage_create;
  users: typeof users;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
