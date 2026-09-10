// Draft canvases submit through the parent workspace, which fixes the revision,
// inputs and approval before a physical ComfyUI request. No seed mutation here.
export function installManagedExecution(app, api, requestExecution) {
  const originalAppQueue = app.queuePrompt;
  const originalApiQueue = api.queuePrompt;
  if (typeof originalAppQueue !== 'function' || typeof originalApiQueue !== 'function') return () => false;
  const appQueue = async () => { requestExecution(); };
  const apiQueue = async () => { throw new Error('This draft must be generated from its conversation'); };
  try {
    app.queuePrompt = appQueue;
    api.queuePrompt = apiQueue;
  } catch {
    // Keep the guard wherever installation succeeded. The host stays locked
    // if both entry points could not be guarded; it must not claim readiness.
  }
  return () => app.queuePrompt === appQueue && api.queuePrompt === apiQueue;
}
