import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { normalizeAuthoringContract as region } from "./authoring-contract-normalization.mjs";
const root = resolve(import.meta.dirname, "..");
const local = region(
  readFileSync(resolve(root, "sdk/src/contract/eval-authoring.ts"), "utf8")
);
const expected = JSON.parse(
  readFileSync(
    resolve(root, "sdk/src/contract/eval-authoring-mirror.json"),
    "utf8"
  )
).sha256;
if (createHash("sha256").update(local).digest("hex") !== expected)
  throw new Error(
    "Authoring contract changed. Compare the backend mirror and update its pin."
  );
const index = process.argv.indexOf("--backend");
if (index >= 0) {
  const backend = region(
    readFileSync(
      resolve(process.argv[index + 1], "convex/lib/evalAuthoring.ts"),
      "utf8"
    )
  );
  const fixture = "eval-authoring-steps-schema.json";
  const localSchema = JSON.parse(
    readFileSync(
      resolve(root, "sdk/src/contract/__fixtures__", fixture),
      "utf8"
    )
  );
  const backendSchema = JSON.parse(
    readFileSync(
      resolve(process.argv[index + 1], "convex/lib/__fixtures__", fixture),
      "utf8"
    )
  );
  if (JSON.stringify(localSchema) !== JSON.stringify(backendSchema))
    throw new Error("Authoring step schemas differ between repositories.");
  if (local !== backend)
    throw new Error("Authoring contract differs from the backend.");
}
console.log("Authoring contract mirror verified.");
