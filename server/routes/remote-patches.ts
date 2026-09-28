import type { FastifyInstance } from 'fastify';
import { createRemotePatchService, createSshTransport, RemotePatchError } from '../application/patches/remote-ssh-service.js';
import { workbenchConfig } from '../../config/workbench.js';
import { createTemporarySshKeyStore } from '../application/patches/temporary-ssh-keys.js';

const enabled = (workbenchConfig.host === '127.0.0.1' || process.env.WORKBENCH_EMBEDDED === '1') && process.env.WORKBENCH_REMOTE_PATCH_AGENT !== '0';
const keyStore = createTemporarySshKeyStore();
const service = createRemotePatchService(createSshTransport(workbenchConfig.patchAgent.installerPath.replace(/[\\/]install\.mjs$/, '')), enabled, keyStore);
function body(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function registerRemotePatchRoutes(app: FastifyInstance): void {
  app.addHook('onClose', async () => { service.disconnect(); keyStore.clear(); });
  app.get('/api/remote-patch', async () => service.status());
  app.post('/api/remote-patch/key', async (request, reply) => {
    if (!enabled) return reply.code(403).send({ error: '远程补丁功能只在本机工作台启用。' });
    try {
      const part = await request.file({ limits: { fileSize: 64 * 1024, files: 1 } });
      if (!part || part.fieldname !== 'file') throw new RemotePatchError('请选择一个 SSH 私钥文件。');
      const contents = await part.toBuffer();
      return { keyFile: keyStore.stage(contents) };
    } catch (error) {
      if (error instanceof RemotePatchError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) return reply.code(413).send({ error: '私钥文件不能超过 64 KiB。' });
      throw error;
    }
  });
  app.delete('/api/remote-patch/key', async (request, reply) => {
    if (!enabled) return reply.code(403).send({ error: '远程补丁功能只在本机工作台启用。' });
    if (service.status().connected) return reply.code(409).send({ error: '请先断开连接。' });
    const reference = body(request.body).keyFile;
    if (typeof reference !== 'string' || !/^ssh-key:[0-9a-f-]{36}$/.test(reference)) return reply.code(400).send({ error: '密钥引用无效。' });
    keyStore.release(reference);
    return { released: true };
  });
  const execute = async (reply: { code: (status: number) => { send: (value: object) => object } }, fn: () => Promise<object>) => {
    try { return await fn(); }
    catch (error) {
      if (error instanceof RemotePatchError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  };
  app.post('/api/remote-patch/probe', async (request, reply) => execute(reply, () => service.probe(body(request.body))));
  app.post('/api/remote-patch/connect', async (request, reply) => execute(reply, () => service.connect(body(request.body))));
  app.post('/api/remote-patch/disconnect', async (_request, reply) => execute(reply, async () => service.disconnect()));
  app.post('/api/remote-patch/history', async (_request, reply) => execute(reply, () => service.history()));
  app.post('/api/remote-patch/remove', async (request, reply) => execute(reply, () => service.remove(body(request.body).token)));
  app.post('/api/remote-patch/discover', async (request, reply) => execute(reply, () => service.discover(body(request.body).patch)));
  app.post('/api/remote-patch/preflight', async (request, reply) => execute(reply, () => {
    const input = body(request.body); return service.preflight(input.patch, input.files);
  }));
  app.post('/api/remote-patch/apply', async (request, reply) => execute(reply, () => service.apply(body(request.body).token)));
}
