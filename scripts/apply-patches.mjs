#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoots = ['.', 'server', 'evals-cli'];
const targetRelativePath = ['node_modules', 'jsondiffpatch', 'lib', 'formatters', 'html.js'];

const searchSnippet = '        context.out(`<li class="${nodeClass}" data-key="${leftKey}">` +\n            `<div class="jsondiffpatch-property-name">${leftKey}</div>`);';
const replacementSnippet = '        const safeKey = htmlEscape(String(leftKey));\n        context.out(`<li class="${nodeClass}" data-key="${safeKey}">` +\n            `<div class="jsondiffpatch-property-name">${safeKey}</div>`);';

function patchHtmlFormatter(baseDir) {
  const filePath = join(baseDir, ...targetRelativePath);
  if (!existsSync(filePath)) {
    return false;
  }

  const original = readFileSync(filePath, 'utf8');
  if (original.includes('const safeKey = htmlEscape')) {
    return false;
  }

  if (!original.includes(searchSnippet)) {
    throw new Error(`Failed to locate jsondiffpatch snippet in ${filePath}`);
  }

  const updated = original.replace(searchSnippet, replacementSnippet);
  writeFileSync(filePath, updated, 'utf8');
  return true;
}

let patchedCount = 0;
for (const base of projectRoots) {
  if (patchHtmlFormatter(base)) {
    patchedCount += 1;
  }
}

if (patchedCount > 0) {
  console.log(`Patched jsondiffpatch HTML formatter in ${patchedCount} location(s).`);
}
