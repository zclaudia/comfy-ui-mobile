/**
 * Bottom sheet for choosing widgets to expose on the form.
 *
 * Two modes:
 *  - `add`  — pick any node, then tick the widgets to expose.
 *  - `link` — pick widgets to link to an existing field; candidates that could
 *             not accept the field's value are listed but disabled, with the
 *             reason, rather than hidden.
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronRight, Link2, Search, X } from 'lucide-react';

import { bindableWidgets } from './formParameters';
import {
  canLinkTargets,
  findFieldForTarget,
  resolveTarget,
  targetsEqual,
  type FormGraphLike,
  type FormNodeLike,
} from '@/shared/utils/mobileForm';
import type { MobileFormField, MobileFormSpec, MobileFormTarget } from '@/shared/types/app/IMobileForm';

interface FormTargetPickerProps {
  mode: 'add' | 'link';
  graph: FormGraphLike | null;
  spec: MobileFormSpec | null;
  /** The field being linked to, in `link` mode. */
  field?: MobileFormField | null;
  onClose: () => void;
  onConfirm: (targets: MobileFormTarget[]) => void;
}

const keyOf = (target: MobileFormTarget) => `${target.nodeId}:${target.widget}`;

export const FormTargetPicker: React.FC<FormTargetPickerProps> = ({
  mode, graph, spec, field, onClose, onConfirm,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [openNodeId, setOpenNodeId] = useState<number | null>(null);
  const [picked, setPicked] = useState<Map<string, MobileFormTarget>>(new Map());

  const primary = useMemo(
    () => (field ? resolveTarget(graph, field.target) : null),
    [graph, field],
  );

  const nodes = useMemo(() => {
    const all = (graph?._nodes || []).filter((node): node is FormNodeLike => !!node);
    const term = query.trim().toLowerCase();
    return all
      .map((node) => ({ node, widgets: bindableWidgets(node) }))
      .filter((entry) => entry.widgets.length > 0)
      .filter((entry) => {
        if (!term) return true;
        const haystack = `${entry.node.title || ''} ${entry.node.type || ''} #${entry.node.id}`.toLowerCase();
        return haystack.includes(term)
          || entry.widgets.some((widget) => String(widget.name).toLowerCase().includes(term));
      });
  }, [graph, query]);

  const toggle = (target: MobileFormTarget) => {
    setPicked((previous) => {
      const next = new Map(previous);
      const key = keyOf(target);
      if (next.has(key)) next.delete(key);
      else next.set(key, target);
      return next;
    });
  };

  /** Why this widget cannot be picked, or null when it can. */
  const rejection = (node: FormNodeLike, widgetName: string): string | null => {
    const target: MobileFormTarget = { nodeId: node.id, widget: widgetName, nodeType: String(node.type || '') };
    if (mode === 'add') {
      const owner = findFieldForTarget(spec, target);
      return owner ? t('form.picker.alreadyOnForm') : null;
    }
    if (!field || !primary) return t('form.picker.unavailable');
    if (targetsEqual(target, field.target)) return t('form.picker.isPrimary');
    if ((field.linked || []).some((linked) => targetsEqual(linked, target))) return t('form.picker.alreadyLinked');
    const verdict = canLinkTargets(primary, resolveTarget(graph, target));
    if (verdict.ok) return null;
    return t(`form.picker.reason.${verdict.reason}`);
  };

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[70] flex flex-col justify-end"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="absolute inset-0 bg-black/60" onClick={onClose} />
        <motion.div
          className="relative flex max-h-[82vh] flex-col rounded-t-[18px] border-t border-white/10 bg-[#101217]"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          style={{ paddingBottom: 'var(--nav-bar-inset, 0px)' }}
        >
          <div className="flex items-center gap-2 px-4 pb-2 pt-3">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[15px] font-bold text-[#e9ebef]">
                {mode === 'add' ? t('form.picker.addTitle') : t('form.picker.linkTitle')}
              </h2>
              <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-[0.1em] text-[#565d6b]">
                {mode === 'link' && field
                  ? t('form.picker.linkSubtitle', { name: field.target.widget })
                  : t('form.picker.addSubtitle')}
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label={t('common.close')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[#1c212c] text-[#e9ebef]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="px-4 pb-2">
            <div className="flex h-9 items-center gap-2 rounded-[10px] border border-white/10 bg-[#14171e] px-2.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-[#565d6b]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('form.picker.searchPlaceholder')}
                aria-label={t('form.picker.searchPlaceholder')}
                className="w-full bg-transparent text-[13px] text-[#e9ebef] outline-none placeholder:text-[#4a5261]"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
            {nodes.length === 0 && (
              <p className="py-8 text-center text-[12px] text-[#565d6b]">{t('form.picker.noNodes')}</p>
            )}
            <div className="flex flex-col gap-1.5">
              {nodes.map(({ node, widgets }) => {
                const open = openNodeId === node.id;
                return (
                  <div key={node.id} className="overflow-hidden rounded-[11px] border border-white/[0.07] bg-[#14171e]">
                    <button
                      onClick={() => setOpenNodeId(open ? null : node.id)}
                      data-form-picker-node={node.id}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold text-[#e9ebef]">
                          {node.title || node.type}
                        </div>
                        <div className="truncate font-mono text-[10px] text-[#565d6b]">
                          #{node.id} · {node.type} · {t('form.picker.widgetCount', { count: widgets.length })}
                        </div>
                      </div>
                      <ChevronRight className={`h-4 w-4 shrink-0 text-[#8a919e] transition-transform ${open ? 'rotate-90' : ''}`} />
                    </button>

                    {open && (
                      <div className="flex flex-col gap-1 border-t border-white/[0.06] px-2 py-2">
                        {widgets.map((widget) => {
                          const name = String(widget.name);
                          const target: MobileFormTarget = { nodeId: node.id, widget: name, nodeType: String(node.type || '') };
                          const blocked = rejection(node, name);
                          const isPicked = picked.has(keyOf(target));
                          return (
                            <button
                              key={name}
                              disabled={!!blocked}
                              onClick={() => toggle(target)}
                              data-form-picker-widget={`${node.id}:${name}`}
                              className={`flex min-h-[44px] items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition-colors ${
                                blocked ? 'cursor-not-allowed opacity-45' : isPicked ? 'bg-[#3069f0]/15' : 'hover:bg-white/[0.04]'
                              }`}
                            >
                              <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border ${
                                isPicked ? 'border-[#3069f0] bg-[#3069f0]' : 'border-white/20'
                              }`}>
                                {isPicked && <Check className="h-3 w-3 text-white" />}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-mono text-[12px] text-[#e9ebef]">{name}</span>
                                {blocked && <span className="block truncate text-[10.5px] text-[#8a919e]">{blocked}</span>}
                              </span>
                              <span className="shrink-0 rounded-[5px] border border-white/10 px-1.5 py-0.5 font-mono text-[9px] uppercase text-[#8a919e]">
                                {String(widget.type || '')}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-white/[0.07] px-4 py-3">
            <span className="flex-1 text-[12px] text-[#8a919e]">
              {t('form.picker.selectedCount', { count: picked.size })}
            </span>
            <button
              onClick={onClose}
              className="h-10 rounded-[11px] border border-white/10 px-4 text-[13px] font-semibold text-[#c8ccd4]"
            >
              {t('common.cancel')}
            </button>
            <button
              disabled={picked.size === 0}
              data-form-picker-confirm
              onClick={() => { onConfirm([...picked.values()]); onClose(); }}
              className="flex h-10 items-center gap-1.5 rounded-[11px] bg-[#3069f0] px-4 text-[13px] font-bold text-white disabled:opacity-40"
            >
              {mode === 'link' && <Link2 className="h-3.5 w-3.5" />}
              {mode === 'add' ? t('form.picker.confirmAdd') : t('form.picker.confirmLink')}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default FormTargetPicker;
