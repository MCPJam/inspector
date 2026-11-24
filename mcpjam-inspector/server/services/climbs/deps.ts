/**
 * What the climb flows need from the outside, in one place so a test can
 * stand in for each: the backend (as the caller), the platform API reached by
 * self-dispatch (the grouped launch, so a climb's runs take the same path as
 * any other launch), and a read of the real server's listing.
 */
import type { ConvexHttpClient } from "convex/browser";
import type { PlatformApiClient } from "@mcpjam/sdk/platform";

export type ClimbDeps = {
  convex: ConvexHttpClient;
  client: Pick<PlatformApiClient, "createEvalRunGroup" | "cancelEvalRun">;
  /** The hash of the real server's tool listing, read now. */
  hashListing: (projectId: string, serverId: string) => Promise<string>;
};
