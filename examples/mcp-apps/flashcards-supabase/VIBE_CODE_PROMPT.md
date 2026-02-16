# Goal

We will create a MCP app (MCP-UI) flashcard app. The user can interact with the LLM to create a set of flashcards, question on one side of the card, answer on the other side. Once generated, the questions and answers will get saved to a database. When the user wants to practice, they can engage with the MCP UI.

The UI allows them to use the flashcard, flip front and back side.

ex. "Create me a study set of US states and their capitols" -> A flashcard set of US states and capitols is created and saved
ex. "I want to study US state capitols" -> User sees MCP UI and can study the flashcards.

## Tool 1: View flashcards

Name: `view_flashcards`
This MCP tool fetches all of the flashcards in the Supabase Database and renders a UI where the user can study the flashcards. The user can click on the card to flip it and see both sides.

Flashcards are always fetched and shuffled randomly.

## Tool 2: Add flashcards

Name: `add_flashcards`
This MCP tool allows us to add one or more flashcards into the database. Each flashcard has two sides. The LLM will pass in the questions and answers as the tool parameter. All the Q/A pairings are saved into the Supabase database as a flashcard object.

# Steps

1. Start off creating a template MCP app using the MCP app Skill, Typescript template.
2. We will be using Supabase. Set up a Supabase project with a database that lets us store flashcard data. Design a database schema, and connect the MCP app to the database.
3. Create functions for fetching and storing flashcards. Calling the tools calls the functions.
   3.1 Hook up the Supabase functions to the MCP server.
4. Create flashcard UI with React for the `view_flashcards` tool.
