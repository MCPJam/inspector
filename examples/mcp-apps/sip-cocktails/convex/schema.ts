import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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

export default defineSchema({
  images: defineTable({
    id: v.string(),
    filename: v.string(),
    contentType: v.string(),
    storageId: v.id("_storage"),
    uploadedAt: v.number(),
  }).index("by_image_id", ["id"]),
  ingredients: defineTable({
    id: v.string(),
    name: v.string(),
    subName: v.optional(v.string()),
    description: v.string(),
    imageId: v.id("images"),
    imageIds: v.optional(v.array(v.id("images"))),
  })
    .index("by_ingredient_id", ["id"])
    .index("by_name", ["name"]),
  cocktails: defineTable({
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
  })
    .index("by_cocktail_id", ["id"])
    .index("by_name", ["name"]),
  users: defineTable({
    name: v.string(),
    tokenIdentifier: v.string(),
    email: v.optional(v.string()),
    picture: v.optional(v.string()),
  }).index("by_token", ["tokenIdentifier"]),
});
