import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
for (const key of ["llm-spend-hourly-ladder-150", "llm-spend-hourly-ladder-400", "llm-new-spenders-hourly", "llm-paid-spenders-hourly"]) {
  test(`${key} preserves small scientific-notation costs`, () => {
    const monitor = JSON.parse(readFileSync(new URL(`./monitors/${key}.json`, import.meta.url)));
    const query = monitor.aplQuery.join("\n");
    for (const field of ["totalCost", "additionalCostToCharge"]) {
      const pattern = query.match(new RegExp(`extract\\('("${field}":[^']+)'`))?.[1];
      assert.ok(pattern);
      const value = Number(new RegExp(pattern).exec(`{"${field}":5e-7}`)?.[1]);
      assert.equal(value, 5e-7);
      assert.equal(Math.ceil(value * 1e6) / 1e6, 0.000001);
    }
    assert.match(query, /ceiling\(totalCost \* 1000000/);
  });
}
