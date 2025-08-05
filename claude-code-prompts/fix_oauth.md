## Issue
The MCP OAuth flow does not work on the Vite + Hono version of MCPJam. It is working in the Next.js version of MCPJam, which lives in the directory inspector-next. 

## What needs fixing
Please investigate why OAuth initiation is broken in Vite + Hono but working in inspector-next. Investigate first and make a proposal before implementing.

## Places to look 
In the Vite + Hono version, the client code lives in /client and the backend server lives in /server. In the Next.js code, the backend lives in src/app/api

