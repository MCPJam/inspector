import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const upsertIngredient = mutation({
  args: {
    id: v.string(),
    name: v.string(),
    subName: v.optional(v.string()),
    description: v.string(),
    imageId: v.id("images"),
    imageIds: v.optional(v.array(v.id("images"))),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("ingredients")
      .withIndex("by_ingredient_id", (q) => q.eq("id", args.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        subName: args.subName,
        description: args.description,
        imageId: args.imageId,
        imageIds: args.imageIds,
      });
      return existing._id;
    }

    return ctx.db.insert("ingredients", {
      id: args.id,
      name: args.name,
      subName: args.subName,
      description: args.description,
      imageId: args.imageId,
      imageIds: args.imageIds,
    });
  },
});
