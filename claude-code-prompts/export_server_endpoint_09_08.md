## Instructions

Below is an initial proposal. Feel free to add improvements where you think there's opportunity. Propose how to do it before implementing it. Feel free to ask follow up questions.

## Objective

I want to create a way to export all of the MCP server's information as a JSON. I want to export all tools (tool name, description, params, etc), resources, prompts, as a JSON file.

## How to do it

Create an api endpoint /mcp/export/server that takes in a `serverId` and generates a JSON of all of the server's information. Have the endpoint live in /server/routes/mcp.
