import { dbClient } from ".";
import { api } from "../../_generated/api";

export const getUserIdFromApiKeyOrNull = async (apiKey: string) => {
  const db = dbClient();
  const user = await db.mutation(
    api.apiKeys.validateApiKeyAndReturnUserIdOrNull,
    { apiKey },
  );
  if (!user) {
    throw new Error("Invalid API key");
  }
  return user;
};
