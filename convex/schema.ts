import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  users: defineTable({
    // Basic user profile and plan for open-core gating
    externalId: v.string(), // WorkOS user id or subject
    email: v.string(),
    name: v.string(),
    imageUrl: v.string(),
    plan: v.string(), // 'oss' | 'pro'
    entitlements: v.any(), // optional entitlements blob
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_externalId", ["externalId"]).index("by_email", ["email"]),
});

