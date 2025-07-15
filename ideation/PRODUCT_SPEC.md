# MCPJam Product Spec (Building v.1.0.0)
We're seeing a meteoric rise of interest in Model Context Protocol (MCP) and developers building MCP servers. The protocol is so early (released last November), and dev tooling for MCP developers is still a very pre-mature space. There's an opportunity to build really good dev tooling for the MCP dev tool community. Good dev tooling lowers the barrier to entry for MCP devs, accelerating the maturity of this space. Since we started working on the MCPJam inspector, we've nearly reached 400 stars on GitHub and an active community of contributors. Many MCP devs I've spoken prefer to use MCPJam over other dev tools. 

However, I don't think MCPJam is anywhere close to complete. We're far from this project becoming the ultimate MCP dev tool with full specs implemented. This document outlines our vision to build an enterprise-grade open source MCP dev tool for the MCP community. Our v1.0.0 release. 

#### We want this to be a community project
MCPJam wouldn't be where its at right now without the help of the MCP community and their contributions. 

#### Why not directly work on Anthropic's inspector? 
We've been asked this several times by people in the community: "why don't you contribute directly to [@modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector)"? The reason why we decided to build our own is because we think the speed of progress made on Anthropic's inspector hasn't caught up to the speed of changes in the protocol, and the dev community's needs. Approvals for PRs are really slow, and a lot of parts of the protocol haven't been implemented. The project lacks clear direction. 

## Product Requirements 
A high quality MCP testing and debugging tool must have the following specs. This covers the inspector GUI and CLI support. 
#### Smooth connection experience
- Connections must support STDIO, SSE, and Streamable HTTP
- STDIO connections must support remote packages, like running `npx @modelcontextprotocol/server-everything`, and local files like running `node dist/index.js`. 
- SSE and Streamable HTTP connection experience must be able to connect to the server given an `http` URL. They must support the entire [OAuth spec](https://modelcontextprotocol.io/specification/draft/basic/authorization) such as Dynamic Client Registration. 
- For all connections, we must be able to configure timeouts. For STDIO, allow user to add environment variables. For SSE/HTTP, allow the user to configure headers like Bearer tokens. 
- A really simple interface for configuring connections. MCPJam must be friendly for novice developers. 

#### Implements the entire protocol 
- Implements tool calling and all message types that come back (error messages too). Provide a GUI to allow user to fill out tool parameters and manually trigger tools. Display the error message if its an error, or display the raw return result on trigger. 
- 
