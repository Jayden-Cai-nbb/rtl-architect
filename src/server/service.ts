import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { createApp } from './app';
import { Repository } from '../workspace/repository';
import { acquireService } from '../workspace/service-lock';
import { exists, toolRoot, toolVersion, ToolError, workspaceIdentity } from '../workspace/environment';
import { protocolVersion, type ServiceInfo } from '../core/service';

export async function startService(workspace: string, options: { port?: number; apiPort?: number; dev?: boolean; devWebPort?: number } = {}) {
  const identity = await workspaceIdentity(workspace), repository = new Repository(identity.workspaceRoot);
  await repository.getModel();
  const staticDirectory = join(toolRoot, 'dist');
  if (!options.dev && !await exists(join(staticDirectory, 'index.html'))) throw new ToolError('BUILD_REQUIRED', '页面尚未构建；请在工具仓库运行 npm run build。');
  const lock = await acquireService(identity.workspaceRoot), servers: Server[] = [];
  let stopping: Promise<void> | undefined, finished!: () => void;
  const closed = new Promise<void>(resolve => { finished = resolve; });
  function close() {
    stopping ??= (async () => {
      await Promise.all(servers.map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); })));
      await lock.release(); finished();
    })();
    return stopping;
  }
  async function listen(port: number) {
    const server = createServer(); servers.push(server);
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => { server.off('error', fail); done(); }); });
    server.on('error', error => { console.error(error.message); void close(); });
    return { server, port: (server.address() as { port: number }).port };
  }
  try {
    const web = await listen(options.port ?? 0);
    const api = options.apiPort !== undefined && options.apiPort !== web.port ? await listen(options.apiPort) : web;
    const webPort = options.dev ? options.devWebPort ?? 5173 : web.port;
    const info: ServiceInfo = { product: 'rtl-architect', protocolVersion, toolVersion, ...identity, instanceId: lock.instanceId, pid: process.pid,
      apiUrl: `http://127.0.0.1:${api.port}`, webUrl: `http://127.0.0.1:${webPort}` };
    const settings = { service: info, shutdown: () => { setTimeout(() => void close(), 20); } };
    web.server.on('request', createApp(repository, api.port, webPort, options.dev ? undefined : staticDirectory, settings));
    if (api !== web) api.server.on('request', createApp(repository, api.port, webPort, undefined, settings));
    await lock.publish(info);
    return { info, close, closed };
  } catch (error) { await close(); throw error; }
}
