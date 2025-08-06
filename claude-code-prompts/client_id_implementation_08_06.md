# Issue

Currently, I am unable to manually configure a client ID. The Client ID is used for Model Context Protocol (MCP) Dynamic Client Registration. Currently, the Client ID is randomly generated.

# Instructions

Investigate how Client IDs are currently created. Figure out a way to allow the user to manually configure the client ID. Propose how to do this before implementing it.

## References

https://modelcontextprotocol.io/specification/draft/basic/authorization#dynamic-client-registration
client/src/lib/mcp-oauth.ts
server/routes/mcp/oauth.ts
client/src/components/connection/AddServerModal.tsx
client/src/hooks/use-app-state.ts
