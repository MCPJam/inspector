#!/usr/bin/env node
/** Source inventory. Parse registrations without executing application code.
 * Output is source evidence, not deployed coverage. Unresolved expressions stay
 * in the report rather than being silently dropped or counted as verified.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const ts = require('typescript');
export const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '__tests__', 'tests', 'test', 'fixtures', '_generated']);

export function sourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => {
    if (SKIP.has(e.name) || e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx') || e.name.endsWith('.d.ts')) return [];
    const p = path.join(root, e.name);
    return e.isDirectory() ? sourceFiles(p) : EXTENSIONS.includes(path.extname(p)) ? [p] : [];
  });
}
export function parseFile(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('x') ? ts.ScriptKind.TSX : file.endsWith('.js') || file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
}
export function visit(node, fn) { fn(node); ts.forEachChild(node, c => visit(c, fn)); }
export function method(call) { return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ''; }
export function literal(node) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  return null;
}
export function rootReceiver(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isCallExpression(node)) return rootReceiver(node.expression);
  if (ts.isPropertyAccessExpression(node)) return rootReceiver(node.expression);
  return null;
}
export function callee(call) { return call.expression.getText(); }
export function prop(obj, name) {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  const p = obj.properties.find(p => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText().replace(/['"]/g, '') === name);
  return p && ts.isShorthandPropertyAssignment(p) ? p.name : p?.initializer ?? null;
}
export function enclosingFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) return p.name?.getText() ?? 'anonymous';
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      if (ts.isVariableDeclaration(p.parent)) return p.parent.name.getText();
      if (ts.isPropertyAssignment(p.parent)) return p.parent.name.getText();
    }
  }
  return 'module';
}
export function conditions(node) {
  const found = [];
  for (let p = node.parent; p; p = p.parent) if (ts.isIfStatement(p)) found.push(p.expression.getText().slice(0, 180));
  return found.reverse();
}
export function signals(node) {
  const found = new Set();
  visit(node, n => {
    if (!ts.isCallExpression(n)) return;
    const name = callee(n);
    if (/(?:logger\.(?:event|systemEvent|error|warn)|emitOperationalEvent|reportOperationalIssue|reportRouteFailure|captureException|maybeCaptureOriginError|captureProductEvent|captureServerEvent|captureCommandEvent|track$)/.test(name)) {
      const event = literal(n.arguments[0]);
      found.add(name + (typeof event === 'string' ? ':' + event.slice(0, 140) : ''));
    }
  });
  return [...found];
}
export function resolveModule(file, spec, root) {
  let base;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(file), spec);
  else if (spec.startsWith('@/')) base = path.join(root, 'mcpjam-inspector/client/src', spec.slice(2));
  else if (spec === '@mcpjam/sdk') base = path.join(root, 'sdk/src/index');
  else return null;
  base = base.replace(/\.(js|mjs)$/, '');
  return [base, ...EXTENSIONS.map(e => base + e), ...EXTENSIONS.map(e => path.join(base, 'index' + e))].find(p => fs.existsSync(p) && fs.statSync(p).isFile()) ?? null;
}
