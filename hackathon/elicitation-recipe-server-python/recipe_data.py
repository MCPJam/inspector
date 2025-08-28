RECIPES = {
    "vegetarian": {
        "quick": [
            {
                "name": "Caprese Salad",
                "time": "10 minutes",
                "difficulty": "Easy",
                "ingredients": ["tomatoes", "mozzarella", "basil", "olive oil", "balsamic vinegar"],
                "instructions": [
                    "Slice fresh tomatoes and mozzarella",
                    "Arrange alternating slices on a plate",
                    "Add fresh basil leaves",
                    "Drizzle with olive oil and balsamic vinegar",
                    "Season with salt and pepper"
                ]
            },
            {
                "name": "Avocado Toast",
                "time": "5 minutes",
                "difficulty": "Easy",
                "ingredients": ["bread", "avocado", "lime", "salt", "pepper", "red pepper flakes"],
                "instructions": [
                    "Toast bread until golden",
                    "Mash avocado with lime juice",
                    "Spread avocado on toast",
                    "Season with salt, pepper, and red pepper flakes",
                    "Optional: add cherry tomatoes or eggs"
                ]
            }
        ],
        "moderate": [
            {
                "name": "Mushroom Risotto",
                "time": "30 minutes",
                "difficulty": "Medium",
                "ingredients": ["arborio rice", "mushrooms", "vegetable broth", "onion", "garlic", "white wine", "parmesan", "butter"],
                "instructions": [
                    "Sauté onion and garlic in butter",
                    "Add rice and toast for 2 minutes",
                    "Add wine and stir until absorbed",
                    "Gradually add warm broth, stirring constantly",
                    "Cook until creamy (20-25 minutes)",
                    "Stir in sautéed mushrooms and parmesan"
                ]
            },
            {
                "name": "Vegetable Stir Fry",
                "time": "25 minutes",
                "difficulty": "Medium",
                "ingredients": ["mixed vegetables", "soy sauce", "ginger", "garlic", "sesame oil", "rice", "green onions"],
                "instructions": [
                    "Cook rice according to package directions",
                    "Heat oil in wok or large pan",
                    "Add garlic and ginger, stir for 30 seconds",
                    "Add vegetables in order of cooking time needed",
                    "Stir fry until tender-crisp",
                    "Add soy sauce and sesame oil",
                    "Serve over rice with green onions"
                ]
            }
        ],
        "elaborate": [
            {
                "name": "Eggplant Parmesan",
                "time": "60 minutes",
                "difficulty": "Hard",
                "ingredients": ["eggplant", "flour", "eggs", "breadcrumbs", "marinara sauce", "mozzarella", "parmesan", "basil"],
                "instructions": [
                    "Slice eggplant and salt to remove bitterness",
                    "Set up breading station: flour, beaten eggs, breadcrumbs",
                    "Bread eggplant slices and fry until golden",
                    "Layer fried eggplant with sauce and cheese",
                    "Bake at 375°F for 25-30 minutes",
                    "Let rest 10 minutes before serving"
                ]
            }
        ]
    },
    "vegan": {
        "quick": [
            {
                "name": "Hummus Bowl",
                "time": "10 minutes",
                "difficulty": "Easy",
                "ingredients": ["hummus", "cucumber", "tomatoes", "olives", "pita bread", "olive oil", "paprika"],
                "instructions": [
                    "Spread hummus in a bowl",
                    "Dice cucumber and tomatoes",
                    "Arrange vegetables on hummus",
                    "Add olives and drizzle with olive oil",
                    "Sprinkle with paprika",
                    "Serve with warm pita bread"
                ]
            }
        ],
        "moderate": [
            {
                "name": "Lentil Curry",
                "time": "35 minutes",
                "difficulty": "Medium",
                "ingredients": ["red lentils", "coconut milk", "curry powder", "onion", "garlic", "ginger", "tomatoes", "spinach"],
                "instructions": [
                    "Sauté onion, garlic, and ginger",
                    "Add curry powder and cook until fragrant",
                    "Add lentils, coconut milk, and diced tomatoes",
                    "Simmer for 20-25 minutes until lentils are tender",
                    "Stir in spinach until wilted",
                    "Season with salt and serve over rice"
                ]
            }
        ],
        "elaborate": [
            {
                "name": "Stuffed Bell Peppers",
                "time": "50 minutes",
                "difficulty": "Hard",
                "ingredients": ["bell peppers", "quinoa", "black beans", "corn", "onion", "tomatoes", "nutritional yeast", "herbs"],
                "instructions": [
                    "Cook quinoa according to package directions",
                    "Hollow out bell peppers and blanch briefly",
                    "Sauté onion and mix with quinoa, beans, corn",
                    "Add diced tomatoes and seasonings",
                    "Stuff peppers with quinoa mixture",
                    "Bake at 375°F for 30-35 minutes"
                ]
            }
        ]
    },
    "gluten_free": {
        "quick": [
            {
                "name": "Greek Salad",
                "time": "15 minutes",
                "difficulty": "Easy",
                "ingredients": ["cucumber", "tomatoes", "red onion", "feta cheese", "olives", "olive oil", "lemon", "oregano"],
                "instructions": [
                    "Chop cucumber, tomatoes, and red onion",
                    "Combine vegetables in a large bowl",
                    "Add olives and crumbled feta cheese",
                    "Whisk olive oil, lemon juice, and oregano",
                    "Toss salad with dressing",
                    "Let marinate for 10 minutes before serving"
                ]
            }
        ],
        "moderate": [
            {
                "name": "Salmon with Roasted Vegetables",
                "time": "30 minutes",
                "difficulty": "Medium",
                "ingredients": ["salmon fillets", "broccoli", "carrots", "zucchini", "olive oil", "lemon", "herbs", "garlic"],
                "instructions": [
                    "Preheat oven to 400°F",
                    "Cut vegetables into uniform pieces",
                    "Toss vegetables with oil, salt, and pepper",
                    "Roast vegetables for 15 minutes",
                    "Add seasoned salmon to the pan",
                    "Roast another 12-15 minutes until salmon flakes easily"
                ]
            }
        ],
        "elaborate": [
            {
                "name": "Paella with Seafood",
                "time": "45 minutes",
                "difficulty": "Hard",
                "ingredients": ["bomba rice", "saffron", "seafood mix", "chicken broth", "bell peppers", "peas", "tomatoes", "garlic"],
                "instructions": [
                    "Heat oil in paella pan",
                    "Sauté garlic and tomatoes until thick",
                    "Add rice and toast briefly",
                    "Add saffron-infused hot broth",
                    "Arrange seafood and vegetables on top",
                    "Cook without stirring for 20-25 minutes",
                    "Let rest 5 minutes before serving"
                ]
            }
        ]
    },
    "meat": {
        "quick": [
            {
                "name": "Chicken Caesar Wrap",
                "time": "15 minutes",
                "difficulty": "Easy",
                "ingredients": ["chicken breast", "tortilla", "romaine lettuce", "caesar dressing", "parmesan", "croutons"],
                "instructions": [
                    "Cook chicken breast and slice",
                    "Warm tortilla briefly",
                    "Spread caesar dressing on tortilla",
                    "Add lettuce, chicken, and parmesan",
                    "Sprinkle with croutons for crunch",
                    "Roll tightly and slice in half"
                ]
            }
        ],
        "moderate": [
            {
                "name": "Beef Tacos",
                "time": "25 minutes",
                "difficulty": "Medium",
                "ingredients": ["ground beef", "taco seasoning", "tortillas", "lettuce", "tomatoes", "cheese", "sour cream", "onion"],
                "instructions": [
                    "Brown ground beef in a large pan",
                    "Add taco seasoning and water as directed",
                    "Simmer until thickened",
                    "Warm tortillas in dry pan or microwave",
                    "Prepare toppings: dice tomatoes, shred lettuce",
                    "Serve beef in tortillas with desired toppings"
                ]
            }
        ],
        "elaborate": [
            {
                "name": "Braised Short Ribs",
                "time": "3 hours",
                "difficulty": "Hard",
                "ingredients": ["beef short ribs", "red wine", "beef broth", "carrots", "celery", "onion", "tomato paste", "herbs"],
                "instructions": [
                    "Sear short ribs in Dutch oven until browned",
                    "Remove ribs and sauté vegetables",
                    "Add tomato paste and cook 1 minute",
                    "Deglaze with red wine",
                    "Return ribs to pot with broth and herbs",
                    "Cover and braise in 325°F oven for 2.5-3 hours",
                    "Strain sauce and serve with ribs"
                ]
            }
        ]
    }
}