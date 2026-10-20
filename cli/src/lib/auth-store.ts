import { writeStoredAuth as writeSharedAuth } from "@mcpjam/sdk/platform-auth";
import type { StoredPlatformAuth } from "@mcpjam/sdk/platform-auth";
import { operationalError } from "./output.js";
export {
  clearStoredAuth,
  getAuthFilePath,
  readStoredAuth,
} from "@mcpjam/sdk/platform-auth";
export type {
  StoredPlatformAuth,
  AuthStorePathOptions,
} from "@mcpjam/sdk/platform-auth";

export async function writeStoredAuth(
  contents: StoredPlatformAuth,
  filePath: string
): Promise<string> {
  try {
    return await writeSharedAuth(contents, filePath);
  } catch (error) {
    throw operationalError(
      error instanceof Error ? error.message : String(error),
      {
        source:
          error instanceof Error && error.cause instanceof Error
            ? error.cause.message
            : String(error),
      }
    );
  }
}
