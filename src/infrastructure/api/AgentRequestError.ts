/** HTTP failure from the Gateway agent API. `status` lets callers branch (409 stale version, 422 unsupported canvas). */
export class AgentRequestError extends Error {
  constructor(readonly status: number, message: string, readonly body?: Record<string, unknown>) { super(message); this.name = 'AgentRequestError'; }
}
