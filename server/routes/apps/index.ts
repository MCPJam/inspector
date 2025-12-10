import { Hono } from "hono";
import chatgpt from "./chatgpt";

const apps = new Hono();

apps.get("/health", (c) =>
  c.json({
    service: "Apps API",
    status: "ready",
    timestamp: new Date().toISOString(),
  }),
);

apps.route("/chatgpt", chatgpt);

export default apps;
