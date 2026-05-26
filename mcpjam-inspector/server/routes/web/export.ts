import { Hono } from "hono";
import { projectServerSchema, withEphemeralConnection } from "./auth.js";
import { exportServer } from "../../utils/export-helpers.js";

const exporter = new Hono();

// POST /server — export all server info (tools, resources, prompts) as JSON
exporter.post("/server", async (c) =>
  withEphemeralConnection(c, projectServerSchema, (manager, body) =>
    exportServer(manager, body.serverId),
  ),
);

export default exporter;
