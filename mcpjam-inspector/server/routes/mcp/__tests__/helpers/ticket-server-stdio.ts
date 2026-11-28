/** The ticket fixture as a stdio child: `node --import tsx ticket-server-stdio.ts <dispatch-log>`. */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildTicketServer, logDispatchTo, newTicketStore } from "./ticket-server.js";

const log = process.argv[2];
if (!log) throw new Error("Pass the dispatch log file as the first argument.");
await serveStdio(() => buildTicketServer(newTicketStore(), logDispatchTo(log)));
