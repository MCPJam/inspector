import path from 'node:path';
import { createHash } from 'node:crypto';
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
      const validPath = typeof route === 'string', validMethod = typeof verb === 'string';
      const valid = validPath && validMethod;
      const expression = pathNode?.getText() ?? '<missing>';
      if (!validPath) unresolved.push({ file: info.file, line: info.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, reason: 'dynamic Convex route', expression });
      const methodExpression = prop(obj, 'method')?.getText() ?? '<missing>';
      if (!validMethod) unresolved.push({ file: info.file, line: info.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, reason: 'dynamic Convex method', expression: methodExpression });
      const methodLabel = validMethod ? verb : methodExpression;
      add('backend', backendRoot, info.file, node, 'convex.http', `${methodLabel} ${validPath ? route : expression}`,
        { id: `backend:convex.http:${path.relative(backendRoot, info.file)}:${enclosingFunction(node)}:${methodLabel}:${valid ? route : expression + ':' + node.getStart()}`,
          method: validMethod ? verb : null, methodExpression: validMethod ? null : methodExpression, path: validPath ? route : null, pathExpression: validPath ? null : expression, scope: enclosingFunction(node),
          status: valid ? 'instrumented-unverified' : 'unknown', reason: valid ? 'Convex execution backstop; returned HTTP status and handled outcome not proven' : 'Unresolved registration path or method requires review', prefix: Boolean(prop(obj, 'pathPrefix')) });
    }
  }
}
function receiverOwner(node, receiver) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p) && p.parameters.some(param => param.name.getText() === receiver)) return p;
  }
  return null;
}
function walkRouter(context, info, receiver, prefix, entrypoint, chain = [], inheritedConditions = [], mounts = [], owner = null) {
    const {modules,add,unresolved,routeIds,inspectorRoot}=context;
    const key = `${info.file}:${receiver}:${owner?.getStart() ?? 'module'}`;
    if (chain.includes(key)) return;
    chain = [...chain, key];
    for (const r of info.routes.filter(r => r.receiver === receiver && receiverOwner(r.node, receiver) === owner)) {
      let methods = r.method === 'on' ? routeValues(modules, r.node.arguments[0], info, r.node) : r.method.toUpperCase();
      methods = Array.isArray(methods) ? methods : [methods];
      const routePath = routeValues(modules, r.node.arguments[r.method === 'on' ? 1 : 0], info, r.node);
      const paths = Array.isArray(routePath) ? routePath : [routePath];
      for (const local of paths) for (const verb of methods) {
        if (typeof local !== 'string' || typeof verb !== 'string') { unresolved.push({ file: info.file, line: r.node.getSourceFile().getLineAndCharacterOfPosition(r.node.getStart()).line + 1, reason: 'dynamic route path/method', entrypoint }); continue; }
        const full = join(prefix, local), endpointId = `inspector:http:${entrypoint}:${verb}:${full}`;
        const position = r.node.getSourceFile().getLineAndCharacterOfPosition(r.node.getStart());
        const guards = [...inheritedConditions, ...conditions(r.node)];
        const evidence = { file: path.relative(inspectorRoot, info.file), line: position.line + 1, column: position.character + 1, conditions: guards, mounts };
        const registrationKey = JSON.stringify([endpointId, evidence]);
        if (routeIds.has(registrationKey)) continue;
        routeIds.add(registrationKey);
        const registrationId = createHash('sha256').update(registrationKey).digest('hex').slice(0, 16);
        const health = /\/(health|healthz)$/.test(full);
        const requestLogged = full.startsWith('/api/') && !health;
        add('inspector', inspectorRoot, info.file, r.node, 'inspector.http', `${verb} ${full}`,
          { id: `${endpointId}:${registrationId}`, endpointId, entrypoint, method: verb, path: full, conditions: guards, mounts, column: evidence.column, adapter: requestLogged ? 'requestLogContextMiddleware (/api/*)' : null,
            status: requestLogged ? 'instrumented-unverified' : 'gap',
            reason: requestLogged ? 'Request-completion adapter mounted; admission exits, terminal streams and live delivery still unverified' : 'No request-completion adapter at this path (health skips deliberate but exemption needs review)' });
      }
    }
    for (const r of info.mounts.filter(r => r.receiver === receiver && receiverOwner(r.node, receiver) === owner)) {
      const line = r.node.getSourceFile().getLineAndCharacterOfPosition(r.node.getStart()).line + 1;
      if (typeof r.path !== 'string' || !r.argument) { unresolved.push({ file: info.file, line, reason: 'dynamic mount', entrypoint }); continue; }
      const symbol = ts.isCallExpression(r.argument) ? r.argument.expression.getText() : r.argument.getText();
      const target = resolve(modules, info, symbol);
      if (!target) { unresolved.push({ file: info.file, line, symbol, mount: r.path, reason: 'unresolved router mount', entrypoint }); continue; }
      walkRouter(context, target.info, target.symbol, join(prefix, r.path), entrypoint, chain, [...inheritedConditions, ...conditions(r.node)], [...mounts, { file: path.relative(inspectorRoot, info.file), line, kind: 'mount' }]);
    }
    for (const helper of info.helpers.filter(h => h.receiver === receiver && receiverOwner(h.node, receiver) === owner)) {
      const imp = info.imports.get(helper.name), targetInfo = imp ? modules.get(imp.target) : info;
      const fn = targetInfo?.functions.get(imp?.symbol ?? helper.name);
      const line = helper.node.getSourceFile().getLineAndCharacterOfPosition(helper.node.getStart()).line + 1;
      if (!fn) { unresolved.push({ file: info.file, line, helper: helper.name, reason: 'unresolved route helper', entrypoint }); continue; }
      const param = fn.parameters[0]?.name.getText();
      if (param) walkRouter(context, targetInfo, param, prefix, entrypoint, chain, [...inheritedConditions, ...conditions(helper.node)], [...mounts, { file: path.relative(inspectorRoot, info.file), line, kind: 'helper' }], fn);
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
