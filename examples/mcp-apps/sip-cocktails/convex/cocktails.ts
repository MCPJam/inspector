import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

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

    const resolveImage = async (imageId: Id<"images">) => {
      const imageDoc = await ctx.db.get(imageId);
      if (!imageDoc) {
        return null;
      }
      const url = await ctx.storage.getUrl(imageDoc.storageId);
      return { ...imageDoc, url };
    };

    const image = await resolveImage(cocktail.imageId);
    const ingredients = await Promise.all(
      cocktail.ingredients.map(async (entry) => {
        const ingredient = await ctx.db.get(entry.ingredientId);
        if (!ingredient) {
          return null;
        }
        const ingredientImage = await resolveImage(ingredient.imageId);
        const extraImages = ingredient.imageIds
          ? await Promise.all(
              ingredient.imageIds.map(async (imageId) =>
                resolveImage(imageId),
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
