---
"@mcpjam/inspector": patch
---

A signed-in user who opens a project they cannot see can ask for access from that screen; a guest is offered sign-in first and comes back to the same link. The project owner, or an organization owner when the owner has left, gets a bell notification that opens `/access-requests/:requestId`, where they approve or decline. Approving adds the requester to the organization as a guest with editor access to that project only, the same as sharing it. When the approval needs a paid seat, the page says who has to finish the seat payment and links to organization billing.
