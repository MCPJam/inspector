#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import { sourceFiles, signals, enclosingFunction, conditions } from './observability-inventory/ast.mjs';
import {collectModule} from './observability-inventory/registrations.mjs';
import {collectConvexRoutes,collectInspectorRoutes} from './observability-inventory/routes.mjs';
export {sourceFiles,parseFile} from './observability-inventory/ast.mjs';
function rowEmitter(rows) {
  return (repo, root, file, node, kind, name, extra = {}) => {
    const relative = path.relative(root, file);
    const line = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const candidate = kind.endsWith('.candidate') || ['convex.scheduled', 'react.error-boundary', 'runtime.failure-handler', 'mcp.registration', 'discord.handler'].includes(kind);
    const column = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).character + 1;
    const row = { id: `${repo}:${kind}:${relative}:${enclosingFunction(node)}:${candidate ? line + ':' + column + ':' : ''}${name}`, repo, kind, name,
      file: relative, line, owner: kind.startsWith('convex') ? 'backend domain maintainer' : relative.split('/')[0] + ' maintainer',
      sourceSignals: signals(node), conditions: conditions(node), status: 'unknown', verified: false,
      reason: 'Source discovery only; behavioral and deployed delivery proof pending', ...extra };
    rows.push(row); return row;
  };
}
export function discover(inspectorRoot,backendRoot) {
 const rows=[], unresolved=[], modules=new Map(), add=rowEmitter(rows);
  const candidates = [
    ...sourceFiles(path.join(inspectorRoot, 'mcpjam-inspector/server')),
    ...sourceFiles(path.join(inspectorRoot, 'mcpjam-inspector/client/src')),
    ...sourceFiles(path.join(inspectorRoot, 'mcpjam-inspector/src')),
    ...sourceFiles(path.join(inspectorRoot, 'mcpjam-inspector/shared')),
    ...['cli', 'sdk', 'mcp', 'slack-app', 'discord-app', 'soundcheck', 'widget-react', 'surface-core', 'evaluators', 'design-system', 'chat-ui', 'vitest'].flatMap(p => sourceFiles(path.join(inspectorRoot, p))),
    ...sourceFiles(path.join(backendRoot, 'convex')),
  ];
 for(const file of candidates) modules.set(file,collectModule(file,inspectorRoot,backendRoot,add));
 const context={modules,rows,unresolved,add,inspectorRoot,backendRoot};
 collectConvexRoutes(context);collectInspectorRoutes(context);
  const counts = {};
  for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  const workspaceFile = path.join(inspectorRoot, 'package.json');
  const workspaceNames = fs.existsSync(workspaceFile) ? JSON.parse(fs.readFileSync(workspaceFile, 'utf8')).workspaces ?? [] : [];
  const packages = workspaceNames.map(name => {
    const p = JSON.parse(fs.readFileSync(path.join(inspectorRoot, name, 'package.json'), 'utf8'));
    return { directory: name, name: p.name, entrypoints: p.exports ?? p.main ?? p.bin ?? null,
      runtimeRows: rows.filter(r => r.repo === 'inspector' && r.file.startsWith(name + '/')).length,
      disposition: ['evaluators','design-system','chat-ui','widget-react','surface-core','vitest'].includes(name) ? 'Shared library: caller inheritance and detached work require review' : 'Runtime/API surface included' };
  });
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), sourceRoots: { inspector: inspectorRoot, backend: backendRoot }, packages,
    method: 'TypeScript AST registrations/calls; application modules are never executed',
    limitations: ['Conditional routes are retained as a union of supported modes; conditions require deployment evaluation',
      'Candidates are not semantic proof of complete journey, browser-operation or durable lifecycle discovery',
      'Dynamic MCP catalog names and unresolved router mounts remain review work',
      'No row is production-verified from source alone'],
    counts, unresolved, rows };
}
export function writeReport(report, dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'inventory.json'), JSON.stringify(report, null, 2) + '\n');
  const columns = ['id', 'repo', 'kind', 'name', 'entrypoint', 'file', 'line', 'status', 'reason', 'sourceSignals'];
  const cell = x => '"' + (Array.isArray(x) ? x.join('; ') : String(x ?? '')).replaceAll('"', '""') + '"';
  fs.writeFileSync(path.join(dir, 'inventory.csv'), [columns.map(cell).join(','), ...report.rows.map(r => columns.map(c => cell(r[c])).join(','))].join('\n') + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [inspector, backend, out] = process.argv.slice(2);
  if (!inspector || !backend || !out) throw new Error('Usage: node scripts/observability-inventory.mjs INSPECTOR_ROOT BACKEND_ROOT OUTPUT_DIR');
  const report = discover(path.resolve(inspector), path.resolve(backend));
  writeReport(report, path.resolve(out));
  process.stdout.write(JSON.stringify({ counts: report.counts, unresolved: report.unresolved.length, verified: report.rows.filter(r => r.verified).length }) + '\n');
}
