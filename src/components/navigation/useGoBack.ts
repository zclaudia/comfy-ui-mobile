import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { backTarget, currentHistoryIndex } from './backNavigation';

/**
 * Back-arrow handler shared by every routed page: pop history when there is any, otherwise
 * replace with `fallback`. `/` resolves to the remembered tab, which is where side-menu pages belong.
 */
export function useGoBack(fallback = '/'): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    const target = backTarget(currentHistoryIndex(), fallback);
    if (target.kind === 'history') navigate(-1);
    else navigate(target.path, { replace: true });
  }, [navigate, fallback]);
}
