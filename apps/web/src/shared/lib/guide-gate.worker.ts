/**
 * The Worker entry (`main` in `wrangler.jsonc`): the US-119 User Guide gate, whose logic is
 * `guide-worker-gate.ts`.
 *
 * This file exports its handler and NOTHING else. workerd reads every named export of the entry
 * module as an entrypoint, so an exported constant stops the Worker from starting — `wrangler dev`
 * refused it with "Incorrect type for map entry 'SESSION_COOKIE': the provided value is not of type
 * 'function or ExportedHandler'". Pinned by `src/test/guide-worker.test.ts`.
 */
import { handleWorkerRequest, type GuideWorkerEnv } from './guide-worker-gate'

export default {
  fetch(request: Request, env: GuideWorkerEnv): Promise<Response> {
    return handleWorkerRequest(request, env)
  },
}
