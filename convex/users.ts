import { mutation, internalMutation } from "./_generated/server";

// Upsert a user record on first login. Stores basic profile and plan defaults.
export const ensureUser = mutation(async (ctx) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  const externalId = identity.subject;
  const email = identity.email ?? "";
  const name = identity.name ?? "";
  const imageUrl = (identity as any).picture ?? "";

  const now = Date.now();

  const existing = await ctx.db
    .query("users")
    .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      email,
      name,
      imageUrl,
      updatedAt: now,
    });
    return existing._id;
  }

  const userId = await ctx.db.insert("users", {
    externalId,
    email,
    name,
    imageUrl,
    plan: "oss",
    entitlements: {},
    createdAt: now,
    updatedAt: now,
  });
  return userId;
});

export type Plan = "oss" | "pro";

export const requirePlan = (required: Plan) =>
  internalMutation(async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required");
    const existing = await ctx.db
      .query("users")
      .withIndex("by_externalId", (q) => q.eq("externalId", identity.subject))
      .unique();
    if (!existing) throw new Error("User not found");
    const ok = existing.plan === required || (required === "oss" && !!existing);
    if (!ok) throw new Error("Insufficient plan");
    return existing._id;
  });

