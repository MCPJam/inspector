import { action, mutation } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { WorkOS } from "@workos-inc/node";

type WorkOSUser = {
  email?: string;
  name?: string;
  profilePictureUrl?: string;
  picture?: string;
  profile_picture_url?: string;
  firstName?: string;
  lastName?: string;
};

type Identity = {
  tokenIdentifier: string;
  subject?: string | null;
  name?: string;
  email?: string;
  picture?: string;
};

type UserProfile = {
  tokenIdentifier: string;
  name: string;
  email?: string;
  picture?: string;
};

function buildProfile(identity: Identity, workosUser?: WorkOSUser | null): UserProfile {
  const mergedName = [workosUser?.firstName, workosUser?.lastName]
    .filter(Boolean)
    .join(" ");
  const name =
    workosUser?.name ??
    (mergedName.length > 0 ? mergedName : identity.name ?? "Anonymous");
  const email = workosUser?.email ?? identity.email ?? undefined;
  const picture =
    workosUser?.profilePictureUrl ??
    workosUser?.profile_picture_url ??
    workosUser?.picture ??
    identity.picture ??
    undefined;

  return {
    tokenIdentifier: identity.tokenIdentifier,
    name,
    email,
    picture,
  };
}

export const upsert = mutation({
  args: {
    tokenIdentifier: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    picture: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_token", (q) =>
        q.eq("tokenIdentifier", args.tokenIdentifier),
      )
      .unique();

    if (existing) {
      const needsUpdate =
        existing.name !== args.name ||
        existing.email !== args.email ||
        existing.picture !== args.picture;
      if (needsUpdate) {
        await ctx.db.patch(existing._id, {
          name: args.name,
          email: args.email,
          picture: args.picture,
        });
      }
      return {
        ...existing,
        name: args.name,
        email: args.email,
        picture: args.picture,
      };
    }

    const id = await ctx.db.insert("users", {
      name: args.name,
      tokenIdentifier: args.tokenIdentifier,
      email: args.email,
      picture: args.picture,
    });
    return await ctx.db.get(id);
  },
});

export const syncCurrent = action({
  args: {},
  handler: async (ctx): Promise<Doc<"users"> | null> => {
    "use node";
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }
    let workosUser: WorkOSUser | null = null;
    const apiKey = process.env.WORKOS_API_KEY;
    if (apiKey && identity.subject) {
      const workos = new WorkOS(apiKey);
      workosUser = (await workos.userManagement.getUser(
        identity.subject,
      )) as WorkOSUser;
    }
    const profile = buildProfile(identity, workosUser);
    return ctx.runMutation(api.users.upsert, profile);
  },
});
