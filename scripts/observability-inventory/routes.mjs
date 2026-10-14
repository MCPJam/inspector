import path from 'node:path';
import {ts,prop,enclosingFunction,conditions} from './ast.mjs';
import { resolve, staticValue, routeBindings, routeValues } from './resolve.mjs';
const join=(a,b)=>('/'+(a+'/'+b).split('/').filter(Boolean).join('/'));
export function collectConvexRoutes(context) {
 const {modules,backendRoot,unresolved,add}=context;
  for (const info of modules.values()) for (const node of info.backendRoutes) {
    const obj = node.arguments[0], pathNode = prop(obj, 'path') ?? prop(obj, 'pathPrefix');
    for (const binding of routeBindings(modules, info, node)) {
      const route = staticValue(modules, pathNode, info, node, new Set(), binding);
      const verb = staticValue(modules, prop(obj, 'method'), info, node, new Set(), binding);
      const valid = typeof route === 'string';
      const expression = pathNode?.getText() ?? '<missing>';
      if (!valid) unresolved.push({ file: info.file, line: info.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, reason: 'dynamic Convex route', expression });
      add('backend', backendRoot, info.file, node, 'convex.http', `${verb} ${valid ? route : expression}`,
        { id: `backend:convex.http:${path.relative(backendRoot, info.file)}:${enclosingFunction(node)}:${verb}:${valid ? route : expression + ':' + node.getStart()}`,
          method: verb, path: valid ? route : null, pathExpression: valid ? null : expression, scope: enclosingFunction(node),
          status: valid ? 'instrumented-unverified' : 'unknown', reason: 'Convex execution backstop; returned HTTP status and handled outcome not proven', prefix: Boolean(prop(obj, 'pathPrefix')) });
    }
  }
}
function walkRouter(context, info, receiver, prefix, entrypoint, chain = [], inheritedConditions = []) {
    const {modules,add,unresolved,routeIds,inspectorRoot}=context;
    const key = `${info.file}:${receiver}`;
    if (chain.includes(key)) return;
    chain = [...chain, key];
    for (const r of info.routes.filter(r => r.receiver === receiver)) {
      let methods = r.method === 'on' ? routeValues(modules, r.node.arguments[0], info, r.node) : r.method.toUpperCase();
      methods = Array.isArray(methods) ? methods : [methods];
      const routePath = routeValues(modules, r.node.arguments[r.method === 'on' ? 1 : 0], info, r.node);
      const paths = Array.isArray(routePath) ? routePath : [routePath];
      for (const local of paths) for (const verb of methods) {
        if (typeof local !== 'string' || typeof verb !== 'string') { unresolved.push({ file: info.file, line: r.node.getSourceFile().getLineAndCharacterOfPosition(r.node.getStart()).line + 1, reason: 'dynamic route path/method', entrypoint }); continue; }
        const full = join(prefix, local), id = `${entrypoint}:${verb}:${full}`;
        if (routeIds.has(id)) continue;
        routeIds.add(id);
        const health = /\/(health|healthz)$/.test(full);
        const requestLogged = full.startsWith('/api/') && !health;
        add('inspector', inspectorRoot, info.file, r.node, 'inspector.http', `${verb} ${full}`,
          { id: 'inspector:http:' + id, entrypoint, method: verb, path: full, conditions: [...inheritedConditions, ...conditions(r.node)], adapter: requestLogged ? 'requestLogContextMiddleware (/api/*)' : null,
            status: requestLogged ? 'instrumented-unverified' : 'gap',
            reason: requestLogged ? 'Request-completion adapter mounted; admission exits, terminal streams and live delivery still unverified' : 'No request-completion adapter at this path (health skips deliberate but exemption needs review)' });
      }
    }
    for (const r of info.mounts.filter(r => r.receiver === receiver)) {
      if (typeof r.path !== 'string' || !r.argument) { unresolved.push({ file: info.file, reason: 'dynamic mount', entrypoint }); continue; }
      const symbol = ts.isCallExpression(r.argument) ? r.argument.expression.getText() : r.argument.getText();
      const target = resolve(modules, info, symbol);
      if (!target) { unresolved.push({ file: info.file, symbol, mount: r.path, reason: 'unresolved router mount', entrypoint }); continue; }
      walkRouter(context, target.info, target.symbol, join(prefix, r.path), entrypoint, chain, [...inheritedConditions, ...conditions(r.node)]);
    }
    for (const helper of info.helpers.filter(h => h.receiver === receiver)) {
      const imp = info.imports.get(helper.name), targetInfo = imp ? modules.get(imp.target) : info;
      const fn = targetInfo?.functions.get(imp?.symbol ?? helper.name);
      if (!fn) continue;
      const param = fn.parameters[0]?.name.getText();
      if (param) walkRouter(context, targetInfo, param, prefix, entrypoint, chain, [...inheritedConditions, ...conditions(helper.node)]);
    }
  }
export function collectInspectorRoutes(context) {
 const {modules,inspectorRoot}=context;
 const routeIds=new Set();
  for (const entry of ['mcpjam-inspector/server/index.ts', 'mcpjam-inspector/server/app.ts']) {
    const info = modules.get(path.join(inspectorRoot, entry));
    if (info) walkRouter({...context,routeIds}, info, 'app', '', entry);
  }
}
