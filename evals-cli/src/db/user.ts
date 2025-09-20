import { dbClient } from ".";

export const getUserIdFromApiKeyOrNull = async (apiKey: string) => {
  const db = dbClient();
  const user = await db.mutation(
    "apiKeys:validateApiKeyAndReturnUserIdOrNull" as any,
    { apiKey },
  );
  if (!user) {
    throw new Error("Invalid API key");
  }
  return user;
};
