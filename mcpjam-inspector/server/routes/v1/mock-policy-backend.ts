/**
 * The backend functions behind the mock forwarding policy: the one place the
 * Inspector names them.
 *
 * ASSUMPTION (B2 is not settled): the policy lives on the workspace (or the
 * organization, for a project without one), and the backend exposes
 *   mockPolicy:getForMock      query    { mockId }               -> MockPolicyRow
 *   mockPolicy:getForProject   query    { projectId }            -> MockPolicyRow
 *   mockPolicy:setForProject   mutation { projectId, forwarding } -> MockPolicyRow  (admin only)
 * with `MockPolicyRow = { forwarding: "allow" | "block", scope: "workspace" |
 * "organization", updatedAt: number | null }`. A caller who is not an admin is
 * refused with the ordinary `kind: 'forbidden'` shape. Change the names here
 * if B2 settles on others.
 */
import { makeFunctionReference } from "convex/server";
import type { PlatformMockPolicy } from "@mcpjam/sdk/platform";
import { createConvexClient } from "./convex-client.js";

const fn = {
  forMock: makeFunctionReference<"query">("mockPolicy:getForMock"),
  forProject: makeFunctionReference<"query">("mockPolicy:getForProject"),
  setForProject: makeFunctionReference<"mutation">("mockPolicy:setForProject"),
};

export const readMockPolicy = (token: string, mockId: string): Promise<PlatformMockPolicy> =>
  createConvexClient(token).query(fn.forMock, { mockId });

export const readProjectPolicy = (token: string, projectId: string): Promise<PlatformMockPolicy> =>
  createConvexClient(token).query(fn.forProject, { projectId });

export const writeProjectPolicy = (
  token: string,
  projectId: string,
  forwarding: "allow" | "block",
): Promise<PlatformMockPolicy> =>
  createConvexClient(token).mutation(fn.setForProject, { projectId, forwarding });
