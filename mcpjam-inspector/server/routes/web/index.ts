import { Hono } from "hono";
import { webError, mapRuntimeError } from "./errors.js";
import servers from "./servers.js";
import tools from "./tools.js";
import resources from "./resources.js";
import prompts from "./prompts.js";
import chatV2 from "./chat-v2.js";
import apps from "./apps.js";
import oauthWeb from "./oauth.js";
import exporter from "./export.js";

const web = new Hono();

web.route("/servers", servers);
web.route("/tools", tools);
web.route("/resources", resources);
web.route("/prompts", prompts);
web.route("/export", exporter);
web.route("/chat-v2", chatV2);
web.route("/apps", apps);
web.route("/oauth", oauthWeb);

web.onError((error, c) => {
  const routeError = mapRuntimeError(error);
  return webError(c, routeError.status, routeError.code, routeError.message);
});

export default web;
