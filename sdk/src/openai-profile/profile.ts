/** The OpenAI profile contract. IDs are compared byte-for-byte, never normalized. */
export interface OpenAIProfile {
  id: string;
  name?: string;
  email?: string;
  nickname?: string;
}

export function isOpenAIProfile(value: unknown): value is OpenAIProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return (
    typeof profile.id === "string" &&
    /\S/.test(profile.id) &&
    Object.entries(profile).every(
      ([key, field]) =>
        ["id", "name", "email", "nickname"].includes(key) &&
        typeof field === "string"
    )
  );
}

export function findOpenAIProfileTool<
  T extends { _meta?: Record<string, unknown> }
>(tools: readonly T[]): T | undefined {
  const marked = tools.filter(
    (tool) => tool._meta?.["openai/profile"] === true
  );
  return marked.length === 1 ? marked[0] : undefined;
}
