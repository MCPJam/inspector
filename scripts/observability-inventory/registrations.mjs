import path from 'node:path';
import {ts,visit,method,literal,rootReceiver,callee,prop,enclosingFunction,resolveModule,parseFile} from './ast.mjs';
function collectImports(info, root) {
 const {sf,file}=info;
    for (const s of sf.statements) {
      if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
        const target = resolveModule(file, s.moduleSpecifier.text, root);
        if (s.importClause?.name) info.imports.set(s.importClause.name.text, { target, symbol: 'default' });
        const named = s.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) for (const e of named.elements) info.imports.set(e.name.text, { target, symbol: e.propertyName?.text ?? e.name.text });
      }
      if (ts.isExportAssignment(s)) info.exports.set('default', s.expression.getText());
      if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) && s.exportClause && ts.isNamedExports(s.exportClause)) {
        const target = resolveModule(file, s.moduleSpecifier.text, root);
        for (const e of s.exportClause.elements) info.imports.set(e.name.text, { target, symbol: e.propertyName?.text ?? e.name.text });
      }
      if (ts.isFunctionDeclaration(s) && s.name) info.functions.set(s.name.text, s);
    }
}
function collectDeclarations(node, context) {
  const { backend, repo, root, rel, file, info, add } = context;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        info.declarations.set(node.name.text, node.initializer);
        if (/new Hono(?:<[^>]*>)?\(/.test(node.initializer.getText())) info.routers.add(node.name.text);
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) info.functions.set(node.name.text, node.initializer);
        if (rel.startsWith('sdk/src/') && node.type && /PlatformOperation</.test(node.type.getText()) && ts.isObjectLiteralExpression(node.initializer)) {
          const name = literal(prop(node.initializer, 'name'));
          if (name) add(repo, root, file, node, 'sdk.operation', name, { symbol: node.name.text });
        }
        if (rel.startsWith('soundcheck/src/app/') && rel.endsWith('/route.ts') && ['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].includes(node.name.text)) {
          add(repo, root, file, node, 'soundcheck.http', node.name.text + ' ' + rel.replace(/^soundcheck\/src\/app/,'').replace(/\/route.ts$/,''));
        }
        if (backend && ts.isCallExpression(node.initializer)) {
          const builder = node.initializer.expression.getText();
          const type = builder.match(/(?:^|\.)(?:[a-zA-Z]*)(Query|Mutation|Action)$|^(query|mutation|action|internalQuery|internalMutation|internalAction|httpAction)$/);
          const statement = node.parent.parent;
          if (type && !/^custom(Query|Mutation|Action)$/.test(builder) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
            const kind = /query/i.test(builder) ? 'query' : /mutation/i.test(builder) ? 'mutation' : 'action';
            add(repo, root, file, node, 'convex.function.' + kind, node.name.text,
              { builder, status: 'instrumented-unverified', reason: 'Convex function_execution backstop; handled outcomes and configured Sentry integration unverified' });
          }
        }
      }
}
function collectRuntimeCalls(node, context) {
  const { backend, repo, root, rel, file, info, add } = context;
      if (ts.isCallExpression(node)) {
        const m = method(node), receiver = ts.isPropertyAccessExpression(node.expression) ? rootReceiver(node.expression.expression) : null;
        if (rel.startsWith('mcpjam-inspector/server/')) {
          if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'on', 'route'].includes(m)) {
            const registration = { node, receiver, scope: enclosingFunction(node), method: m,
              path: literal(node.arguments[m === 'on' ? 1 : 0]), argument: node.arguments[m === 'route' ? 1 : m === 'on' ? 2 : 1] };
            (m === 'route' ? info.mounts : info.routes).push(registration);
          }
          if (ts.isIdentifier(node.expression) && /^register|^mount.*Routes$/.test(node.expression.text)) info.helpers.push({ node, name: node.expression.text, receiver: node.arguments[0]?.getText() });
        }
        if (backend && m === 'route' && ts.isObjectLiteralExpression(node.arguments[0])) {
          info.backendRoutes.push(node);
        }
        if (backend && receiver === 'crons' && ['interval', 'hourly', 'daily', 'weekly', 'monthly', 'cron'].includes(m)) {
          add(repo, root, file, node, 'convex.cron', literal(node.arguments[0]) ?? '<dynamic>',
            { schedule: node.arguments[1]?.getText(), target: node.arguments[2]?.getText(), status: 'instrumented-unverified', reason: 'Registration exists; per-target heartbeat/detector and live execution unverified' });
        }
        if (backend && /\.scheduler\.(runAfter|runAt)$/.test(callee(node))) {
          add(repo, root, file, node, 'convex.scheduled', node.arguments[1]?.getText() ?? '<dynamic>', { scope: enclosingFunction(node), delay: node.arguments[0]?.getText() });
        }
        if (backend && /\.db\.(patch|insert|replace)$/.test(callee(node))) {
          const obj = node.arguments[1];
          if (ts.isObjectLiteralExpression(obj) && (prop(obj, 'status') || prop(obj, 'state'))) {
            add(repo, root, file, node, 'durable.writer.candidate', enclosingFunction(node),
              { statusExpression: (prop(obj, 'status') ?? prop(obj, 'state')).getText(), reason: 'State writer candidate; lifecycle/stage mapping and terminal proof require semantic review' });
          }
        }
      }
}
function collectSurfaceCalls(node, context) {
  const { backend, repo, root, rel, file, add } = context;
      if (ts.isCallExpression(node)) {
        const m = method(node), receiver = ts.isPropertyAccessExpression(node.expression) ? rootReceiver(node.expression.expression) : null;
        if (rel.startsWith('cli/src/') && m === 'command') add(repo, root, file, node, 'cli.command', literal(node.arguments[0]) ?? '<dynamic>',
          { id: `${repo}:cli.command:${rel}:${enclosingFunction(node)}:${receiver}:${literal(node.arguments[0]) ?? node.getStart()}`,
            parentExpression: ts.isPropertyAccessExpression(node.expression) ? node.expression.expression.getText().slice(0, 100) : null,
            status: 'instrumented-unverified', reason: 'CLI main captures command completion through PostHog; Axiom reliability and diagnostic requirements pending' });
        if (rel.startsWith('mcp/src/') && ['registerTool', 'registerResource', 'setRequestHandler'].includes(m)) add(repo, root, file, node, 'mcp.registration', literal(node.arguments[0]) ?? node.arguments[0]?.getText() ?? '<dynamic>',
          { dynamic: literal(node.arguments[0]) === null, reason: 'Resolve dynamic operation catalog and caller inheritance; registration is not delivery proof' });
        if (rel.startsWith('slack-app/') && receiver === 'app' && ['event', 'action', 'command', 'view', 'message'].includes(m)) add(repo, root, file, node, 'slack.handler', literal(node.arguments[0]) ?? node.arguments[0]?.getText() ?? '<dynamic>');
        if (rel.startsWith('discord-app/') && receiver === 'client' && ['on', 'once'].includes(m)) add(repo, root, file, node, 'discord.handler', literal(node.arguments[0]) ?? node.arguments[0]?.getText() ?? '<dynamic>');
        if (/^(mcpjam-inspector\/client\/src|widget-react\/src)\//.test(rel) && /(^fetch$|\.fetch$|\.fetchQuery$|\.fetchMutation$|\.fetchAction$|^use(Query|Mutation|Action)$)/.test(callee(node))) add(repo, root, file, node, 'browser.request.candidate', enclosingFunction(node),
          { call: callee(node), reason: 'Request callsite; operation/adapter/catch mapping must be reviewed' });
        if (!backend && ((receiver === 'process' && ['on', 'once'].includes(m) && ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM', 'exit', 'beforeExit'].includes(literal(node.arguments[0]))) ||
          m === 'addEventListener' && ['error', 'unhandledrejection'].includes(literal(node.arguments[0])))) add(repo, root, file, node, 'runtime.failure-handler', literal(node.arguments[0]));
        if (rel.startsWith('mcpjam-inspector/src/') && ['on', 'once', 'handle'].includes(m) && ['ready', 'before-quit', 'will-quit', 'render-process-gone', 'child-process-gone'].includes(literal(node.arguments[0]))) add(repo, root, file, node, 'desktop.lifecycle', literal(node.arguments[0]));
        if (rel.startsWith('sdk/src/') && ts.isIdentifier(node.expression) && /(?:define|create).*Operation/.test(node.expression.text)) {
          const obj = node.arguments.find(ts.isObjectLiteralExpression);
          if (obj) add(repo, root, file, node, 'sdk.operation', literal(prop(obj, 'name')) ?? enclosingFunction(node));
        }
      }
}
function collectSurfaceDeclarations(node, context) {
  const { repo, root, rel, file, add } = context;
      if (rel.startsWith('soundcheck/src/app/') && rel.endsWith('/route.ts') && ts.isFunctionDeclaration(node) && node.name && ['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].includes(node.name.text)) {
        add(repo, root, file, node, 'soundcheck.http', node.name.text + ' ' + rel.replace(/^soundcheck\/src\/app/,'').replace(/\/route.ts$/,''));
      }
      if (rel === 'mcp/src/index.ts' && ts.isMethodDeclaration(node) && node.name.getText() === 'fetch') {
        add(repo, root, file, node, 'mcp.http-handler', 'worker.fetch', { reason: 'Worker admission/discovery/MCP dispatch boundary; API downstream observations do not cover all worker refusals' });
      }
      if (ts.isParameter(node) && node.type && /\bHono\b/.test(node.type.getText())) info.routers.add(node.name.getText());
      if (rel === 'mcpjam-inspector/client/src/lib/app-routes.ts' && ts.isObjectLiteralExpression(node) && prop(node, 'path') && prop(node, 'kind')) {
        add(repo, root, file, node, 'product.screen', literal(prop(node, 'path')) ?? '<dynamic>',
          { routeKind: literal(prop(node, 'kind')), surfaceId: literal(prop(node, 'surfaceId')), routeScope: literal(prop(node, 'scope')),
            reason: 'Product surface discovered; stage questions, authoritative outcomes and sink applicability require catalog review' });
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (/ErrorBoundary$/.test(node.tagName.getText())) add(repo, root, file, node, 'react.error-boundary', node.tagName.getText(),
          { status: 'instrumented-unverified', reason: 'Error boundary mounted; reporter, eligible errors and received diagnostics unverified' });
      }
}
export function collectModule(file, inspectorRoot, backendRoot, add) {
 const backend=file.startsWith(backendRoot+path.sep), repo=backend?"backend":"inspector";
 const root=backend?backendRoot:inspectorRoot, rel=path.relative(root,file), sf=parseFile(file);
 const info={file,sf,imports:new Map(),declarations:new Map(),functions:new Map(),exports:new Map(),routes:[],backendRoutes:[],mounts:[],helpers:[],routers:new Set()};
 collectImports(info,root);
 const context={backend,repo,root,rel,file,info,add};
 visit(sf,node=>{collectDeclarations(node,context);collectRuntimeCalls(node,context);collectSurfaceCalls(node,context);collectSurfaceDeclarations(node,context);});
 return info;
}
