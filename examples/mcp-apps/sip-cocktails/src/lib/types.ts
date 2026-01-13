export type ImageDoc = {
  _id: string;
  id: string;
  filename: string;
  contentType: string;
  storageId: string;
  uploadedAt: number;
  url: string | null;
};

export type IngredientDoc = {
  _id: string;
  id: string;
  name: string;
  subName?: string;
  description: string;
  imageId: string;
  imageIds?: string[];
  image?: ImageDoc | null;
  images?: ImageDoc[];
};

export type CocktailIngredient = {
  ingredientId: string;
  measurements: Record<string, number>;
  displayOverrides?: Record<string, string>;
  note?: string;
  optional?: boolean;
  ingredient: IngredientDoc;
};

export type CocktailData = {
  _id: string;
  id: string;
  name: string;
  tagline: string;
  subName?: string;
  description: string;
  instructions: string;
  hashtags: string[];
  garnish?: string;
  nutrition: {
    abv: number;
    sugar: number;
    volume: number;
    calories: number;
  };
  image?: ImageDoc | null;
  ingredients: CocktailIngredient[];
};
