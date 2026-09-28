import type { FastifyInstance } from 'fastify';
import { createPatchAgent, PatchAgentError } from '../application/patches/patch-agent-service.js';
import { workbenchConfig } from '../../config/workbench.js';

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const agent = createPatchAgent({
  enabled: workbenchConfig.patchAgent.enabled,
  roots: workbenchConfig.patchAgent.roots,
  backupDirectory: workbenchConfig.patchAgent.backupDirectory,
  installerPath: workbenchConfig.patchAgent.installerPath,
  allowRuntimeRoots: process.env.WORKBENCH_PATCH_ALLOW_RUNTIME_ROOTS === '1',
  testMode: process.env.WORKBENCH_PATCH_TEST_MODE === '1',
});

export function registerPatchRoutes(app: FastifyInstance): void {
  app.post('/api/patch-agent/history', async (request, reply) => {
    try { return await agent.history(bodyRecord(request.body).root); }
    catch (error) { if (error instanceof PatchAgentError) return reply.code(error.statusCode).send({ error: error.message }); throw error; }
  });
  app.post('/api/patch-agent/remove', async (request, reply) => {
    try { return await agent.remove(bodyRecord(request.body).token); }
    catch (error) { if (error instanceof PatchAgentError) return reply.code(error.statusCode).send({ error: error.message }); throw error; }
  });
  app.get('/api/patch-agent', async () => agent.status());

  app.get<{ Querystring: { patch?: string } }>('/api/patch-agent/targets', async (request, reply) => {
    try {
      return agent.discover(request.query.patch);
    } catch (error) {
      if (error instanceof PatchAgentError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post('/api/patch-agent/preflight', async (request, reply) => {
    try {
      const body = bodyRecord(request.body);
      return await agent.run({ patch: body.patch, target: body.target, frontend: body.frontend, server: body.server, apply: false });
    } catch (error) {
      if (error instanceof PatchAgentError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post('/api/patch-agent/apply', async (request, reply) => {
    try {
      const body = bodyRecord(request.body);
      return await agent.run({ patch: body.patch, target: body.target, frontend: body.frontend, server: body.server, confirm: body.confirm, apply: true });
    } catch (error) {
      if (error instanceof PatchAgentError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post('/api/patch-agent/roots', async (request, reply) => {
    try {
      const body = bodyRecord(request.body);
      return agent.setRoots([body.root]);
    } catch (error) {
      if (error instanceof PatchAgentError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
