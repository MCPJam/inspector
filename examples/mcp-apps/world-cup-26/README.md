# World Cup 2026 MCP App

![World Cup 2026](./groupsSS.png)

A complete MCP App for predicting the 2026 FIFA World Cup bracket.

**Live at**: https://worldcup-2026-mcp.ignaciojimenezrocabado.workers.dev/mcp

## Project Structure

```
world-cup-26/
├── server/          # HTTP server + MCP tools
│   ├── index.ts
│   ├── teams.ts
│   └── bracket-template.ts
├── ui/              # React app
│   └── src/
│       ├── components/
│       └── lib/
└── shared/          # Shared TypeScript types
    └── types.ts
```

## Tech Stack

**Runtime:** Cloudflare Workers (edge computing)  
**Protocol:** Model Context Protocol (MCP)  
**Frontend:** React 18 with TypeScript, Vite, Tailwind CSS  
**UI Components:** Radix UI, Framer Motion, Lucide React  
**Build:** Vite

## Features

- **Group predictions**: Assign positions 1–4 for all 12 groups (A–L)
- **Third-place selection**: Pick 8 of 12 third-place teams to advance
- **Constraint-satisfaction solver**: Automatically assigns third-place teams to R32 slots based on group letter constraints
- **Knockout bracket**: Interactive Round-of-32 → Final bracket
- **Save/load**: Persist predictions via MCP tools

## Third-Place Team Assignment

The app uses a **constraint-satisfaction solver** to assign the 8 qualified third-place teams to Round-of-32 slots. This ensures a valid bracket that respects FIFA's slot-letter constraints.
**Note**: This implementation does not follow FIFA Annexe C exactly, but produces a valid bracket consistent with slot-letter constraints when a solution exists.




