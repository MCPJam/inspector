# Goal

We want to create a hosted version of MCPJam. It will be hosted via Docker on Railway. It must have everything the Desktop version has.

# Current limitations

Currently MCPJam was designed to be a Desktop app ran locally either through `npx`, Electron, Docker. The Hono backend has a MCPClientManager singleton. This means if we host it, everyone will be sharing the same MCPClientManager object, and we will have collisions. People will have access to other people's MCP servers and see everyone else's logs.

We cannot have this singleton behavior in a hosted version. Everyone should have their own MCPClientManager in isolation.

# Requirements

- We want to create a mono-repo that supports both the current local desktop, but also a hosted version.
- In hosted environment, everyone must have their own client manager in isolation.
- Try to scale, handle what happens when there are LOTS of people connected to the server.
- Must be deployable via Docker.
- Changes must be as minimalistic as possible. Least amount of impact and code required as possible.
