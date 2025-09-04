import { defineSchema, defineTable } from "convex/server";
import { authTables } from "convex/server";

export default defineSchema({
  ...authTables,
  users: defineTable({
    // Basic user profile and plan for open-core gating
    externalId: "string", // WorkOS user id or subject
    email: "string",
    name: "string",
    imageUrl: "string",
    plan: "string", // 'oss' | 'pro'
    entitlements: "any", // optional entitlements blob
    createdAt: "number",
    updatedAt: "number",
  }).index("by_externalId", ["externalId"]).index("by_email", ["email"]),
});

