import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";

const measurementSchema = v.object({
  ml: v.optional(v.number()),
  oz: v.optional(v.number()),
  part: v.optional(v.number()),
});

const displayOverridesSchema = v.object({
  ml: v.optional(v.string()),
  oz: v.optional(v.string()),
  part: v.optional(v.string()),
});

async function resolveImage(
  ctx: { db: any; storage: { getUrl: (storageId: Id<"_storage">) => Promise<string | null> } },
  imageId: Id<"images">,
) {
  const imageDoc = await ctx.db.get(imageId);
  if (!imageDoc) {
    return null;
  }
  const url = await ctx.storage.getUrl(imageDoc.storageId);
  return { ...imageDoc, url };
}

async function resolveCocktailDetails(
  ctx: { db: any; storage: { getUrl: (storageId: Id<"_storage">) => Promise<string | null> } },
  cocktail: Doc<"cocktails">,
) {
  const image = await resolveImage(ctx, cocktail.imageId);
  const ingredients = await Promise.all(
    cocktail.ingredients.map(async (entry) => {
      const ingredient = await ctx.db.get(entry.ingredientId);
      if (!ingredient) {
        return null;
      }
      const ingredientImage = await resolveImage(ctx, ingredient.imageId);
      const extraImages = ingredient.imageIds
        ? await Promise.all(
            ingredient.imageIds.map(async (imageId: Id<"images">) =>
              resolveImage(ctx, imageId),
            ),
          )
        : undefined;

      return {
        ...entry,
        ingredient: {
          ...ingredient,
          image: ingredientImage,
          images: extraImages?.filter(Boolean),
        },
      };
    }),
  );

  return {
    ...cocktail,
    image,
    ingredients: ingredients.filter(Boolean),
  };
}

// Read-only version for queries - returns null if user doesn't exist
async function getExistingUser(ctx: {
  auth: { getUserIdentity: () => Promise<null | { tokenIdentifier: string; name?: string; email?: string; picture?: string }> };
  db: any;
}): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }
  return await ctx.db
    .query("users")
    .withIndex("by_token", (q: any) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();
}

// Upsert version for mutations - creates user if they don't exist
async function getOrCreateUser(ctx: {
  auth: { getUserIdentity: () => Promise<null | { tokenIdentifier: string; name?: string; email?: string; picture?: string }> };
  db: any;
}): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }
  const existing = await ctx.db
    .query("users")
    .withIndex("by_token", (q: any) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();
  if (existing) {
    return existing;
  }
  const id = await ctx.db.insert("users", {
    name: identity.name ?? "Anonymous",
    tokenIdentifier: identity.tokenIdentifier,
    email: identity.email ?? undefined,
    picture: identity.picture ?? undefined,
  });
  return await ctx.db.get(id);
}

export const upsertCocktail = mutation({
  args: {
    id: v.string(),
    name: v.string(),
    tagline: v.string(),
    subName: v.optional(v.string()),
    imageId: v.id("images"),
    description: v.string(),
    instructions: v.string(),
    hashtags: v.array(v.string()),
    ingredients: v.array(
      v.object({
        ingredientId: v.id("ingredients"),
        measurements: measurementSchema,
        displayOverrides: v.optional(displayOverridesSchema),
        note: v.optional(v.string()),
        optional: v.optional(v.boolean()),
      }),
    ),
    nutrition: v.object({
      abv: v.number(),
      sugar: v.number(),
      volume: v.number(),
      calories: v.number(),
    }),
    garnish: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("cocktails")
      .withIndex("by_cocktail_id", (q) => q.eq("id", args.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        tagline: args.tagline,
        subName: args.subName,
        imageId: args.imageId,
        description: args.description,
        instructions: args.instructions,
        hashtags: args.hashtags,
        ingredients: args.ingredients,
        nutrition: args.nutrition,
        garnish: args.garnish,
      });
      return existing._id;
    }

    return ctx.db.insert("cocktails", {
      id: args.id,
      name: args.name,
      tagline: args.tagline,
      subName: args.subName,
      imageId: args.imageId,
      description: args.description,
      instructions: args.instructions,
      hashtags: args.hashtags,
      ingredients: args.ingredients,
      nutrition: args.nutrition,
      garnish: args.garnish,
    });
  },
});

export const getCocktailById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const cocktail = await ctx.db
      .query("cocktails")
      .withIndex("by_cocktail_id", (q) => q.eq("id", args.id))
      .unique();

    if (!cocktail) {
      return null;
    }

    return await resolveCocktailDetails(ctx, cocktail);
  },
});

export const getCocktailIdsAndNames = query({
  args: {},
  handler: async (ctx) => {
    const cocktails = await ctx.db.query("cocktails").collect();
    return cocktails.map((cocktail) => ({
      id: cocktail.id,
      name: cocktail.name,
    }));
  },
});

export const saveCocktailRecipeLikedList = mutation({
  args: { cocktailId: v.string() },
  handler: async (ctx, args) => {
    const viewer = await getOrCreateUser(ctx);
    if (!viewer) {
      throw new Error("Not authenticated.");
    }

    const cocktail = await ctx.db
      .query("cocktails")
      .withIndex("by_cocktail_id", (q) => q.eq("id", args.cocktailId))
      .unique();
    if (!cocktail) {
      throw new Error(`Cocktail "${args.cocktailId}" not found.`);
    }

    const existing = await ctx.db
      .query("likedCocktailRecipes")
      .withIndex("by_user_cocktail", (q) =>
        q.eq("userId", viewer._id).eq("cocktailId", args.cocktailId),
      )
      .unique();
    if (existing) {
      return existing._id;
    }

    return ctx.db.insert("likedCocktailRecipes", {
      userId: viewer._id,
      cocktailId: args.cocktailId,
      createdAt: Date.now(),
    });
  },
});

export const getLikedCocktailRecipes = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getExistingUser(ctx);
    if (!viewer) {
      return [];
    }

    const liked = await ctx.db
      .query("likedCocktailRecipes")
      .withIndex("by_user", (q) => q.eq("userId", viewer._id))
      .collect();

    const cocktails = await Promise.all(
      liked.map(async (entry) => {
        const cocktail = await ctx.db
          .query("cocktails")
          .withIndex("by_cocktail_id", (q) => q.eq("id", entry.cocktailId))
          .unique();
        if (!cocktail) {
          return null;
        }
        return await resolveCocktailDetails(ctx, cocktail);
      }),
    );

    return cocktails.filter(Boolean);
  },
});

export const getLikedCocktailIds = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getExistingUser(ctx);
    if (!viewer) {
      return [];
    }

    const liked = await ctx.db
      .query("likedCocktailRecipes")
      .withIndex("by_user", (q) => q.eq("userId", viewer._id))
      .collect();

    return liked.map((entry) => entry.cocktailId);
  },
});
