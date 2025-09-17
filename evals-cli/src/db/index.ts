import { ConvexHttpClient } from "convex/browser";

export const dbClient = () => {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is not set");
  }
  return new ConvexHttpClient(convexUrl);
};
