import type { FastifyInstance } from 'fastify';
import { JobLifecycleError, type createJobLifecycleService } from '../application/translation/job-lifecycle-service.js';

export function registerJobRoutes(app: FastifyInstance, service: ReturnType<typeof createJobLifecycleService>) {
  app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/pause', async (request, reply) => {
    try { return await service.pause(request.params.jobId); }
    catch (error) {
      if (error instanceof JobLifecycleError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
  app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/resume', async (request, reply) => {
    try { return await service.resume(request.params.jobId); }
    catch (error) {
      if (error instanceof JobLifecycleError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
  app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/retry-failed', async (request, reply) => {
    try { return await service.retryFailed(request.params.jobId); }
    catch (error) {
      if (error instanceof JobLifecycleError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
  app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/rerun-postprocessing', async (request, reply) => {
    try { return await service.rerunPostprocessing(request.params.jobId); }
    catch (error) {
      if (error instanceof JobLifecycleError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
  app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/cancel', async (request, reply) => {
    try { return await service.cancel(request.params.jobId); }
    catch (error) {
      if (error instanceof JobLifecycleError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
