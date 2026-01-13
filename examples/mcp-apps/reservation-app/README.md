# Jammy Wammy Reservation MCP App

A simple MCP App demo for making restaurant reservations.

## Project Structure

```
reservation-app/
├── server.ts            # MCP server with tools
├── src/
│   └── reservation.tsx  # React UI component
└── reservation-app.html # HTML entry point
```

## Tech Stack

**Runtime:** Node.js with stdio transport  
**Protocol:** Model Context Protocol (MCP)  
**Frontend:** React 19 with TypeScript  
**Build:** Vite with vite-plugin-singlefile

## Features

- **get-reservation**: Opens an interactive UI to confirm your table reservation
- **get-menu**: Returns the full restaurant menu with prices
- **App-to-client messaging**: The UI can send messages back to the MCP client (e.g., "What's on the menu?")
