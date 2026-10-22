import {ts,visit,literal} from './ast.mjs';
export function resolve(modules, info, symbol, visited = new Set()) {
    if (!info || visited.has(info.file + ':' + symbol)) return null;
    visited.add(info.file + ':' + symbol);
    if (symbol === 'default') symbol = (info.exports.get('default') ?? symbol).replace(/\(.*$/s, '');
    if (info.routers.has(symbol)) return { info, symbol };
    const imported = info.imports.get(symbol);
    if (imported) return resolve(modules, modules.get(imported.target), imported.symbol, visited);
    const fn = info.functions.get(symbol);
    if (fn) {
      let found, delegated;
      visit(fn, n => {
        if (ts.isReturnStatement(n) && n.expression && ts.isIdentifier(n.expression) && info.routers.has(n.expression.text)) found = n.expression.text;
        if (ts.isReturnStatement(n) && n.expression && ts.isCallExpression(n.expression) && ts.isIdentifier(n.expression.expression)) delegated = n.expression.expression.text;
      });
      if (found) return { info, symbol: found };
      if (delegated) return resolve(modules, info, delegated, visited);
    }
    const init = info.declarations.get(symbol);
    if (init && ts.isIdentifier(init)) return resolve(modules, info, init.text, visited);
    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression)) return resolve(modules, info, init.expression.text, visited);
    return null;
  }
export function staticValue(modules, node, info, sourceNode, seen = new Set(), bindings = {}) {
    if (!node || !info) return null;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(e => staticValue(modules, e, info, sourceNode, new Set(seen), bindings)).flat();
    const direct = literal(node);
    if (direct !== null) return direct;
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) return staticValue(modules, node.expression, info, sourceNode, seen, bindings);
    if (ts.isIdentifier(node)) {
      if (Object.hasOwn(bindings, node.text)) return bindings[node.text];
      const key = info.file + ':' + node.text;
      if (seen.has(key)) return null;
      seen.add(key);
      for (let p = sourceNode?.parent; p; p = p.parent) {
        if (ts.isForOfStatement(p) && p.initializer.getText().replace(/^(const|let|var)\s+/, '') === node.text) return staticValue(modules, p.expression, info, null, seen, bindings);
      }
      const imp = info.imports.get(node.text);
      if (imp) {
        const targetInfo = modules.get(imp.target);
        if (!targetInfo) return null;
        const declaration = targetInfo.declarations.get(imp.symbol);
        return staticValue(modules, declaration ?? ts.factory.createIdentifier(imp.symbol), targetInfo, null, seen, bindings);
      }
      return staticValue(modules, info.declarations.get(node.text), info, null, seen, bindings);
    }
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      for (const span of node.templateSpans) {
        const value = staticValue(modules, span.expression, info, sourceNode, new Set(seen), bindings);
        if (typeof value !== 'string') return null;
        result += value + span.literal.text;
      }
      return result;
    }
    if (ts.isBinaryExpression(node)) {
      const left = staticValue(modules, node.left, info, sourceNode, new Set(seen), bindings), right = staticValue(modules, node.right, info, sourceNode, new Set(seen), bindings);
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return typeof left === 'string' && typeof right === 'string' ? left + right : null;
      if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken && left !== null) return left || right;
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && left !== null && right !== null) return left === right;
    }
    if (ts.isConditionalExpression(node)) {
      const condition = staticValue(modules, node.condition, info, sourceNode, new Set(seen), bindings);
      if (typeof condition === 'boolean') return staticValue(modules, condition ? node.whenTrue : node.whenFalse, info, sourceNode, seen, bindings);
    }
    return null;
  }
export function routeBindings(modules, info, sourceNode) {
    let bindings = [{}];
    for (let p = sourceNode.parent; p; p = p.parent) {
      if (!ts.isForOfStatement(p)) continue;
      const name = p.initializer.getText().replace(/^(const|let|var)\s+/, '');
      const values = staticValue(modules, p.expression, info, null);
      if (Array.isArray(values) && values.length <= 100) bindings = bindings.flatMap(b => values.map(value => ({ ...b, [name]: value })));
    }
    return bindings;
  }
export function routeValues(modules, node, info, sourceNode) {
    return routeBindings(modules, info, sourceNode).flatMap(b => staticValue(modules, node, info, sourceNode, new Set(), b));
  }
