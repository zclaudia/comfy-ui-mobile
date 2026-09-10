import type { ReactNode } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useGoBack } from './useGoBack';

/**
 * The two ways out of a screen, kept apart on purpose:
 * - `BackButton` (arrow, top-left) leaves a routed page or a pushed level and returns to the previous one.
 * - `CloseButton` (X, top-right) dismisses an overlay that sits on top of the current page.
 * A given level shows exactly one of them.
 */
export const headerTile = 'w-9 h-9 shrink-0 flex items-center justify-center rounded-[10px] border border-white/[0.08] text-[#c8ccd4] hover:text-white hover:bg-white/[0.08] transition-colors active:scale-95 disabled:opacity-40';
export const headerTileStyle = { background: 'rgba(255,255,255,0.045)' } as const;
const icon = 'w-[17px] h-[17px]';

export function BackButton({ onClick, className = '', label }: { onClick: () => void; className?: string; label?: string }) {
  const { t } = useTranslation();
  return <button type="button" className={`${headerTile} ${className}`} style={headerTileStyle} onClick={onClick} aria-label={label ?? t('common.back')} title={label ?? t('common.back')}>
    <ArrowLeft className={icon} strokeWidth={1.8} />
  </button>;
}

export function CloseButton({ onClick, className = '', label }: { onClick: () => void; className?: string; label?: string }) {
  const { t } = useTranslation();
  return <button type="button" className={`${headerTile} ${className}`} style={headerTileStyle} onClick={onClick} aria-label={label ?? t('common.close')} title={label ?? t('common.close')}>
    <X className={icon} strokeWidth={1.8} />
  </button>;
}

/**
 * Sticky page header for routed pages: back arrow, title block, optional actions on the right and
 * optional extra rows (tabs, search) inside the sticky area so they scroll with the header.
 */
export function PageHeader({ title, subtitle, fallback = '/', onBack, right, children, className = '' }: {
  title: ReactNode; subtitle?: ReactNode;
  /** Where the arrow lands when the app was opened straight onto this page. `/` means the remembered tab. */
  fallback?: string;
  /** Overrides the history-based default, for pages whose parent is not a route (e.g. an editor level). */
  onBack?: () => void;
  right?: ReactNode; children?: ReactNode; className?: string;
}) {
  const goBack = useGoBack(fallback);
  return <header className={`sticky top-0 z-50 shrink-0 pwa-header bg-[#0b0c0f]/95 backdrop-blur-xl border-b border-white/[0.08] ${className}`}>
    <div className="h-14 flex items-center gap-[11px] px-3">
      <BackButton onClick={onBack ?? goBack} />
      <div className="min-w-0 flex-1">
        <h1 className="text-[14px] font-semibold text-[#e9ebef] leading-[1.25] truncate">{title}</h1>
        {subtitle && <p className="font-mono text-[9px] font-medium text-[#565d6b] tracking-[0.12em] uppercase mt-[3px] truncate">{subtitle}</p>}
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </div>
    {children}
  </header>;
}
