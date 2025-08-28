from mcp.server.fastmcp import FastMCP, Context
from mcp.server.elicitation import AcceptedElicitation, DeclinedElicitation, CancelledElicitation
from pydantic import BaseModel, Field
from recipe_data import RECIPES
import random

mcp = FastMCP("Recipe Finder")

class DietaryChoice(BaseModel):
    """Schema for dietary restriction selection"""
    dietary_restriction: str = Field(
        description="Choose your dietary preference",
        enum=["vegetarian", "vegan", "gluten_free", "meat", "no_restriction"]
    )

class CookingTimeChoice(BaseModel):
    """Schema for cooking time selection"""
    cooking_time: str = Field(
        description="How much time do you have for cooking?",
        enum=["quick", "moderate", "elaborate"]
    )


@mcp.tool()
async def find_recipe(ctx: Context) -> str:
    """Find a recipe based on your dietary preferences and time constraints using interactive elicitation."""
    
    try:
        # Step 1: Ask for dietary preferences
        dietary_result = await ctx.elicit(
            message="What are your dietary preferences or restrictions?",
            schema=DietaryChoice
        )
        
        match dietary_result:
            case AcceptedElicitation(data=data):
                dietary_pref = data.dietary_restriction
            case DeclinedElicitation() | CancelledElicitation():
                return "No problem! Feel free to ask again when you're ready to cook."
        
        # Handle "no_restriction" by randomly choosing from available categories
        if dietary_pref == "no_restriction":
            dietary_pref = random.choice(list(RECIPES.keys()))
        
        # Step 2: Ask for cooking time availability
        time_result = await ctx.elicit(
            message="How much time do you have for cooking?",
            schema=CookingTimeChoice
        )
        
        match time_result:
            case AcceptedElicitation(data=data):
                time_available = data.cooking_time
            case DeclinedElicitation() | CancelledElicitation():
                return "No problem! Feel free to ask again when you're ready to cook."
        
        # Step 3: Find matching recipes
        if dietary_pref not in RECIPES or time_available not in RECIPES[dietary_pref]:
            return f"Sorry, no {dietary_pref} recipes found for {time_available} cooking time."
        
        available_recipes = RECIPES[dietary_pref][time_available]
        
        if not available_recipes:
            return f"Sorry, no {dietary_pref} recipes available for {time_available} cooking time."
        
        # Pick a random recipe from matches
        recipe = random.choice(available_recipes)
        
        # Format the recipe response
        ingredients_list = "\n".join([f"- {ingredient}" for ingredient in recipe["ingredients"]])
        instructions_list = "\n".join([f"{i+1}. {instruction}" for i, instruction in enumerate(recipe["instructions"])])
        
        return f"""{recipe['name']}
Time: {recipe['time']}
Difficulty: {recipe['difficulty']}

Ingredients:
{ingredients_list}

Instructions:
{instructions_list}"""
        
    except Exception as e:
        return f"Oops! Something went wrong: {str(e)}"

if __name__ == "__main__":
    mcp.run(transport="sse")