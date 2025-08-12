# Issue

The system prompt editor UI currently lives above the chat input. This takes up too much space. We want to move the system prompt input next to the model selector as a button. Clicking on the button will create a popup with a system prompt text input

# How to fix

1. Remove the System prompt UI. System prompt editor UI lives in client/src/components/ChatTab.tsx
2. Move the system prompt next to the model selector button
   2.1 Create a new component called `SystemPromptSelector` that has system prompt logic
   2.2 Have the SystemPromptSelector component in the client/src/components/chat/chat-input.tsx component right next to `ModelSelector`
   2.3 The system prompt should have a default value "You are a helpful assistant with access to MCP tools."

# Acceptance criteria

User can configure system prompt by clicking on the system prompt selector button and typing in a system prompt to save it.
