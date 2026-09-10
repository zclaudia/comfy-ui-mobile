/**
 * One rule for every "go back" arrow: return to the page the user actually came from.
 * React Router keeps its position in `history.state.idx`; `0` (or nothing) means the app was
 * opened directly on this page, so there is no previous page and we land on `fallback` instead.
 */
export type BackTarget = { kind: 'history' } | { kind: 'path'; path: string };

export function backTarget(historyIndex: unknown, fallback: string): BackTarget {
  return typeof historyIndex === 'number' && historyIndex > 0 ? { kind: 'history' } : { kind: 'path', path: fallback };
}

export function currentHistoryIndex(): unknown {
  try { return window.history.state?.idx; } catch { return undefined; }
}
