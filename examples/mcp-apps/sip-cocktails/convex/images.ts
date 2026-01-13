import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

export const saveImage = mutation({
  args: {
    id: v.string(),
    filename: v.string(),
    contentType: v.string(),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("images")
      .withIndex("by_image_id", (q) => q.eq("id", args.id))
      .unique();
    const uploadedAt = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        filename: args.filename,
        contentType: args.contentType,
        storageId: args.storageId,
        uploadedAt,
      });
      if (existing.storageId !== args.storageId) {
        await ctx.storage.delete(existing.storageId);
      }
      return { storageId: args.storageId, docId: existing._id };
    }

    const docId = await ctx.db.insert("images", {
      id: args.id,
      filename: args.filename,
      contentType: args.contentType,
      storageId: args.storageId,
      uploadedAt,
    });

    return { storageId: args.storageId, docId };
  },
});

export const getImageById = query({
  args: { id: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("images")
      .withIndex("by_image_id", (q) => q.eq("id", args.id))
      .unique(),
});
