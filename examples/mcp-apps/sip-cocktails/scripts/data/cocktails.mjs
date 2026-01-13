export const cocktails = [
  {
    id: "amaretto_sour",
    name: "Amaretto Sour",
    tagline: "A velvety sweet-sour classic.",
    imageId: "amaretto_sour",
    description:
      "Amaretto meets bright lemon with a foamy top for a mellow, balanced sip.",
    instructions:
      "Dry shake all ingredients, then shake with ice. Strain into a chilled coupe.",
    hashtags: ["classic", "sour", "amaretto"],
    ingredients: [
      {
        ingredientId: "amaretto",
        measurements: { oz: 2 },
      },
      {
        ingredientId: "lemon_juice",
        measurements: { oz: 1 },
      },
      {
        ingredientId: "simple_syrup",
        measurements: { oz: 0.5 },
        optional: true,
        note: "Adjust for sweetness based on your amaretto.",
      },
      {
        ingredientId: "egg_white",
        measurements: { oz: 1 },
        displayOverrides: { oz: "1 egg white" },
        optional: true,
      },
    ],
    nutrition: {
      abv: 17,
      sugar: 22,
      volume: 120,
      calories: 220,
    },
    garnish: "Lemon twist",
  },
];
