# Issue

MCPJam API key section in @client/src/components/setting/AccountApiKeySection.tsx is broken. When there is no API key, it still looks like there's an API key, and that you can copy it. The API key can only be seen once, but the current experience is like you can always see it.

# How to fix it.

1. When there is no API key, prompt the user to generate an API key. Upon API key generation, show the API key and ask the user to copy it. The API key can only be seen once.
2. If an API key already exists, prompt the user to "re-generate". Create a warning modal that the old key will be replaced by the new key, and ask for approval.
3. Make it clear that API keys can only be seen once. Do not show the "\***\*\*\*\*\***\*\*\*\*\***\*\*\*\*\***" placeholder.

Feel free to ask follow up clarification questions.
