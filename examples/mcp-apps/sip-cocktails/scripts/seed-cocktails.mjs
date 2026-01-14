#!/usr/bin/env node
import process from "node:process";

import { ConvexHttpClient } from "convex/browser";
import { cocktails } from "./data/cocktails.mjs";
import { ingredients } from "./data/ingredients.mjs";

const convexUrl = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;

if (!convexUrl) {
  console.error("Missing CONVEX_URL or VITE_CONVEX_URL in the environment.");
  process.exit(1);
}

const client = new ConvexHttpClient(convexUrl);

const getImageDoc = async (imageId) => {
  const doc = await client.query("images:getImageById", { id: imageId });
  if (!doc) {
    throw new Error(
      `Missing image "${imageId}". Run the upload script before seeding data.`,
    );
  }
  return doc;
};

const ingredientIdMap = new Map();

for (const ingredient of ingredients) {
  const imageDoc = await getImageDoc(ingredient.imageId);
  const imageIds = ingredient.imageIds
    ? await Promise.all(ingredient.imageIds.map(getImageDoc))
    : undefined;

  const docId = await client.mutation("ingredients:upsertIngredient", {
    id: ingredient.id,
    name: ingredient.name,
    subName: ingredient.subName,
    description: ingredient.description,
    imageId: imageDoc._id,
    imageIds: imageIds?.map((doc) => doc._id),
  });

  ingredientIdMap.set(ingredient.id, docId);
  console.log(`Ingredient ${ingredient.id} -> ${docId}`);
}

for (const cocktail of cocktails) {
  try {
    const imageDoc = await getImageDoc(cocktail.imageId);
    const resolvedIngredients = cocktail.ingredients.map((entry) => {
      const ingredientDocId = ingredientIdMap.get(entry.ingredientId);
      if (!ingredientDocId) {
        throw new Error(
          `Missing ingredient "${entry.ingredientId}" for cocktail "${cocktail.id}".`,
        );
      }
      return {
        ingredientId: ingredientDocId,
        measurements: entry.measurements,
        displayOverrides: entry.displayOverrides,
        note: entry.note,
        optional: entry.optional,
      };
    });

    const docId = await client.mutation("cocktails:upsertCocktail", {
      id: cocktail.id,
      name: cocktail.name,
      tagline: cocktail.tagline,
      subName: cocktail.subName,
      imageId: imageDoc._id,
      description: cocktail.description,
      instructions: cocktail.instructions,
      hashtags: cocktail.hashtags,
      ingredients: resolvedIngredients,
      nutrition: cocktail.nutrition,
      garnish: cocktail.garnish,
    });

    console.log(`Cocktail ${cocktail.id} -> ${docId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Skipping cocktail "${cocktail.id}": ${message}`);
  }
}
