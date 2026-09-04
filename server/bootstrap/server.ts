/**
 * Stable server lifecycle entrypoint.
 *
 * HTTP route registration lives in `server/routes/api.ts`; this module keeps
 * the executable contract used by Node, Docker, and Electron in one place.
 */
export { startWorkbenchServer, stopWorkbenchServer } from '../routes/api.js';
