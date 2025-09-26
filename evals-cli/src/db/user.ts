import { dbClient } from ".";
import { Logger } from "../utils/logger";

export const getUserIdFromApiKeyOrNull = async (apiKey: string) => {
  const db = dbClient();
  const user = await db.mutation(
    "apiKeys:validateApiKeyAndReturnUserIdOrNull" as any,
    { apiKey },
  );
  if (!user) {
    Logger.errorWithExit(
      "Invalid MCPJam API key. Please check your API key and try again.",
    );
  }
  return user;
};
