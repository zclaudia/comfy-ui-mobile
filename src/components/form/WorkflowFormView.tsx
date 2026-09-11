/**
 * The form view: the default surface when a workflow is opened on a phone.
 *
 * It renders only the inputs the workflow's form spec exposes, bound to the
 * very same ComfyGraph and widget editor the canvas uses — so an edit here, an
 * edit on the canvas and a pin from the node panel are all the same edit.
 *
 * Linked fields write through `fanOutLinkedWrite`, which is installed by
 * wrapping the widget editor rather than by teaching each control about links.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, ChevronDown, ExternalLink, Link2, Pencil, Pin, Plus, RefreshCw,
  Trash2, Unlink, WandSparkles,
} from 'lucide-react';

import { WidgetValueEditor } from '@/components/controls/WidgetValueEditor';
import { FormTargetPicker } from './FormTargetPicker';
import { toProcessedParameter } from './formParameters';
import { sectionCategoryId } from '@/core/services/FormSuggestionService';
import {
  addTargetToSpec,
  fanOutLinkedWrite,
  linkTargetToField,
  moveField,
  removeField,
  resolveSpec,
  touchSpec,
  unlinkTargetFromField,
  updateField,
  usableFieldCount,
  writeFieldValue,
  type FormGraphLike,
} from '@/shared/utils/mobileForm';
import type {
  MobileFormField, MobileFormSpec, MobileFormTarget, ResolvedField,
} from '@/shared/types/app/IMobileForm';

export interface FormWidgetEditorApi {
  editingParam: { nodeId: number; paramName: string } | null;
  editingValue: any;
  modifiedWidgetValues: Map<number, Record<string, any>>;
  getWidgetValue: (nodeId: number, paramName: string, originalValue: any) => any;
  setWidgetValue: (nodeId: number, paramName: string, value: any) => void;
  startEditingParam: (nodeId: number, paramName: string, value: any, widgetIndex?: number) => void;
  cancelEditingParam: () => void;
  saveEditingParam: () => void;
  updateEditingValue: (value: any) => void;
}

interface WorkflowFormViewProps {
  graph: FormGraphLike | null;
  spec: MobileFormSpec | null;
  onSpecChange: (spec: MobileFormSpec) => void;
  isEditing: boolean;
  onEditingChange: (editing: boolean) => void;
  onRegenerate: () => void;
  widgetEditor: FormWidgetEditorApi;
  uploadState: any;
  onFilePreview: (filename: string) => void;
  onFileUpload: (nodeId: number, paramName: string) => void;
  onFileUploadDirect?: (nodeId: number, paramName: string, file: File) => void;
  onControlAfterGenerateChange?: (nodeId: number, value: string) => void;
  /** Jumps to the node on the structure view. */
  onOpenNode?: (nodeId: number) => void;
  topOffset: number;
}

export const WorkflowFormView: React.FC<WorkflowFormViewProps> = ({
  graph, spec, onSpecChange, isEditing, onEditingChange, onRegenerate,
  widgetEditor, uploadState, onFilePreview, onFileUpload, onFileUploadDirect,
  onControlAfterGenerateChange, onOpenNode, topOffset,
}) => {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState<{ mode: 'add' | 'link'; field?: MobileFormField } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // getWidgetValue closes over the modification map, so the map itself has to
  // stay in the dependency list: without it an edit would not re-resolve the
  // fields, and a linked field's mismatch badge would never update. The lint
  // rule cannot see through the closure.
  const sections = useMemo(
    () => resolveSpec(graph, spec, widgetEditor.getWidgetValue),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, spec, widgetEditor.getWidgetValue, widgetEditor.modifiedWidgetValues],
  );
  const usable = usableFieldCount(sections);

  /**
   * A widget editor whose writes mirror onto linked targets. Every control
   * inside WidgetValueEditor goes through one of these three entry points.
   */
  const linkedEditor = useMemo((): FormWidgetEditorApi => {
    const fanOut = (nodeId: number, paramName: string, value: any) => {
      fanOutLinkedWrite(graph, spec, nodeId, paramName, value, widgetEditor.setWidgetValue);
    };
    return {
      ...widgetEditor,
      setWidgetValue: (nodeId, paramName, value) => {
        widgetEditor.setWidgetValue(nodeId, paramName, value);
        fanOut(nodeId, paramName, value);
      },
      saveEditingParam: () => {
        const editing = widgetEditor.editingParam;
        const value = widgetEditor.editingValue;
        widgetEditor.saveEditingParam();
        if (editing) fanOut(editing.nodeId, editing.paramName, value);
      },
    };
  }, [graph, spec, widgetEditor]);

  const mutate = useCallback((next: MobileFormSpec) => onSpecChange(touchSpec(next)), [onSpecChange]);

  const handleAdd = useCallback((targets: MobileFormTarget[]) => {
    if (!spec) return;
    let next = spec;
    for (const target of targets) next = addTargetToSpec(next, target);
    mutate(next);
  }, [spec, mutate]);

  const handleLink = useCallback((field: MobileFormField, targets: MobileFormTarget[]) => {
    if (!spec) return;
    let next = spec;
    for (const target of targets) next = linkTargetToField(next, field.id, target);
    mutate(next);
  }, [spec, mutate]);

  const unifyField = useCallback((resolved: ResolvedField) => {
    writeFieldValue(graph, resolved.field, resolved.primary.value, linkedEditor.setWidgetValue);
  }, [graph, linkedEditor]);

  const sectionTitle = (id: string, title: string) => {
    if (title) return title;
    const category = sectionCategoryId(id);
    if (category) return t(`node.category.${category}`);
    return t('form.section.unsorted');
  };

  const renderField = (resolved: ResolvedField) => {
    const { field, primary, linked } = resolved;
    const nodeId = field.target.nodeId;
    const linkCount = 1 + linked.filter((entry) => !entry.problem).length;

    if (!resolved.usable) {
      if (!isEditing) return null;
      return (
        <div key={field.id} className="rounded-[11px] border border-[#f25555]/35 bg-[#f25555]/[0.07] px-3 py-2.5">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#f25555]" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-semibold text-[#e9ebef]">{resolved.label}</div>
              <div className="truncate font-mono text-[10px] text-[#8a919e]">
                #{nodeId} · {t(`form.problem.${primary.problem}`)}
              </div>
            </div>
            <button
              onClick={() => spec && mutate(removeField(spec, field.id))}
              aria-label={t('form.field.remove')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-[#f25555]/40 text-[#f25555]"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      );
    }

    // The control renders the label, so pass the composed one down rather than
    // printing a second line above it.
    const param = { ...toProcessedParameter(primary.node, primary.widget, field), label: resolved.label };

    return (
      <div key={field.id} className="rounded-[11px] border border-white/[0.07] bg-[#14171e] p-2.5" data-form-field={`${nodeId}:${field.target.widget}`}>
        {(linkCount > 1 || resolved.inconsistent || isEditing) && (
          <div className="mb-1.5 flex items-center gap-1.5">
            {linkCount > 1 && (
              <span
                className="flex shrink-0 items-center gap-1 rounded-[6px] border border-[#3069f0]/35 px-1.5 py-0.5 text-[10px] font-semibold text-[#5b8af5]"
                title={t('form.field.linkedTitle')}
              >
                <Link2 className="h-2.5 w-2.5" />
                {t('form.field.linkedCount', { count: linkCount })}
              </span>
            )}

            {resolved.inconsistent && (
              <button
                onClick={() => unifyField(resolved)}
                data-form-unify={field.id}
                className="flex shrink-0 items-center gap-1 rounded-[6px] border border-[#e2b33a]/40 bg-[#e2b33a]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#e2b33a]"
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                {t('form.field.unify')}
              </button>
            )}

            <span className="min-w-0 flex-1" />

            {isEditing && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => onOpenNode?.(nodeId)}
                  aria-label={t('form.field.openNode')}
                  className="flex h-7 w-7 items-center justify-center rounded-[7px] border border-white/10 text-[#8a919e]"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => spec && mutate(moveField(spec, field.id, -1))}
                  aria-label={t('form.field.moveUp')}
                  className="flex h-7 w-7 items-center justify-center rounded-[7px] border border-white/10 text-[#8a919e]"
                >
                  <ChevronDown className="h-3.5 w-3.5 rotate-180" />
                </button>
                <button
                  onClick={() => spec && mutate(moveField(spec, field.id, 1))}
                  aria-label={t('form.field.moveDown')}
                  className="flex h-7 w-7 items-center justify-center rounded-[7px] border border-white/10 text-[#8a919e]"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setPicker({ mode: 'link', field })}
                  aria-label={t('form.field.link')}
                  data-form-link={field.id}
                  className="flex h-7 w-7 items-center justify-center rounded-[7px] border border-white/10 text-[#8a919e]"
                >
                  <Link2 className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setRenamingId(renamingId === field.id ? null : field.id)}
                  aria-label={t('form.field.rename')}
                  className="flex h-7 w-7 items-center justify-center rounded-[7px] border border-white/10 text-[#8a919e]"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => spec && mutate(removeField(spec, field.id))}
                  aria-label={t('form.field.remove')}
                  data-form-remove={field.id}
                  className="flex h-7 w-7 items-center justify-center rounded-[7px] border border-[#f25555]/35 text-[#f25555]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {isEditing && renamingId === field.id && (
          <input
            autoFocus
            defaultValue={field.label || ''}
            placeholder={resolved.label}
            aria-label={t('form.field.rename')}
            onBlur={(event) => {
              const label = event.target.value.trim();
              if (spec) {
                mutate(updateField(spec, field.id, (current) => {
                  const next = { ...current };
                  if (label) next.label = label; else delete next.label;
                  return next;
                }));
              }
              setRenamingId(null);
            }}
            className="mb-2 h-9 w-full rounded-[9px] border border-white/10 bg-[#0f1116] px-2.5 text-[13px] text-[#e9ebef] outline-none focus:border-[#3069f0]"
          />
        )}

        {isEditing && linked.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {linked.map((entry) => (
              <span
                key={`${entry.target.nodeId}:${entry.target.widget}`}
                className={`flex items-center gap-1 rounded-[6px] border px-1.5 py-0.5 font-mono text-[10px] ${
                  entry.problem ? 'border-[#f25555]/35 text-[#f25555]' : 'border-white/10 text-[#8a919e]'
                }`}
              >
                #{entry.target.nodeId}·{entry.target.widget}
                <button
                  onClick={() => spec && mutate(unlinkTargetFromField(spec, field.id, entry.target))}
                  aria-label={t('form.field.unlink')}
                >
                  <Unlink className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        <WidgetValueEditor
          param={param}
          nodeId={nodeId}
          currentValue={primary.value}
          isEditing={widgetEditor.editingParam?.nodeId === nodeId
            && widgetEditor.editingParam?.paramName === field.target.widget}
          editingValue={widgetEditor.editingValue}
          uploadState={uploadState}
          isModified={!!widgetEditor.modifiedWidgetValues.get(nodeId)?.[field.target.widget]}
          modifiedHighlightClasses=""
          onStartEditing={(id, name, value) => widgetEditor.startEditingParam(id, name, value, param.widgetIndex)}
          onCancelEditing={widgetEditor.cancelEditingParam}
          onSaveEditing={linkedEditor.saveEditingParam}
          onEditingValueChange={widgetEditor.updateEditingValue}
          onControlAfterGenerateChange={onControlAfterGenerateChange}
          onFilePreview={onFilePreview}
          onFileUpload={onFileUpload}
          onFileUploadDirect={onFileUploadDirect}
          node={primary.node as any}
          widget={primary.widget}
        />
      </div>
    );
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-10 overflow-y-auto"
      style={{ top: topOffset, background: '#0b0c0f', paddingBottom: 'calc(96px + var(--nav-bar-inset, 0px))' }}
      data-form-view
    >
      <div className="flex flex-col gap-3 px-3.5 pt-3">
        {(usable > 0 || isEditing) && (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#565d6b]">
              {t('form.fieldCount', { count: usable })}
            </span>
            <button
              onClick={() => onEditingChange(!isEditing)}
              data-form-edit-toggle
              aria-pressed={isEditing}
              className={`flex h-8 items-center gap-1.5 rounded-[9px] border px-3 text-[12px] font-semibold transition-colors ${
                isEditing
                  ? 'border-[#3069f0] bg-[#3069f0] text-white'
                  : 'border-white/10 text-[#8a919e]'
              }`}
            >
              <Pencil className="h-3 w-3" />
              {isEditing ? t('form.doneEditing') : t('form.edit')}
            </button>
          </div>
        )}

        {spec?.mode === 'auto' && usable > 0 && (
          <div className="flex items-start gap-2 rounded-[11px] border border-[#3069f0]/25 bg-[#3069f0]/[0.07] px-3 py-2.5">
            <WandSparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#5b8af5]" />
            <p className="flex-1 text-[11.5px] leading-relaxed text-[#8a919e]">{t('form.autoHint')}</p>
          </div>
        )}

        {usable === 0 && !isEditing && (
          <div className="rounded-[12px] border border-white/[0.07] bg-[#101217] px-4 py-8 text-center">
            <Pin className="mx-auto mb-2 h-5 w-5 text-[#565d6b]" />
            <p className="mb-1 text-[13px] font-semibold text-[#e9ebef]">{t('form.empty.title')}</p>
            <p className="text-[11.5px] leading-relaxed text-[#8a919e]">{t('form.empty.body')}</p>
            <button
              onClick={() => onEditingChange(true)}
              data-form-empty-edit
              className="mt-3 h-9 rounded-[10px] bg-[#3069f0] px-4 text-[12.5px] font-semibold text-white"
            >
              {t('form.edit')}
            </button>
          </div>
        )}

        {sections.map(({ section, fields }) => {
          const visible = isEditing ? fields : fields.filter((field) => field.usable);
          if (visible.length === 0) return null;
          const isCollapsed = collapsed.has(section.id);
          return (
            <div key={section.id} className="overflow-hidden rounded-[12px] border border-white/[0.07] bg-[#101217]">
              <button
                onClick={() => setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(section.id)) next.delete(section.id); else next.add(section.id);
                  return next;
                })}
                className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2.5 text-left"
                data-form-section={section.id}
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#e9ebef]">
                  {sectionTitle(section.id, section.title)}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-[#565d6b]">
                  {t('form.section.count', { count: visible.length })}
                </span>
                <ChevronDown className={`h-4 w-4 shrink-0 text-[#8a919e] transition-transform ${isCollapsed ? '' : 'rotate-180'}`} />
              </button>
              <AnimatePresence initial={false}>
                {!isCollapsed && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                  >
                    <div className="flex flex-col gap-2 px-2.5 pb-2.5">{visible.map(renderField)}</div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}

        {isEditing && (
          <div className="flex flex-col gap-2 pb-2">
            <button
              onClick={() => setPicker({ mode: 'add' })}
              data-form-add-field
              className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-[11px] border border-dashed border-white/15 text-[13px] font-semibold text-[#8a919e]"
            >
              <Plus className="h-4 w-4" />
              {t('form.addField')}
            </button>
            <button
              onClick={onRegenerate}
              data-form-regenerate
              className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-[11px] border border-white/10 text-[13px] font-semibold text-[#8a919e]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('form.regenerate')}
            </button>
          </div>
        )}
      </div>

      {picker && (
        <FormTargetPicker
          mode={picker.mode}
          graph={graph}
          spec={spec}
          field={picker.field}
          onClose={() => setPicker(null)}
          onConfirm={(targets) => {
            if (picker.mode === 'add') handleAdd(targets);
            else if (picker.field) handleLink(picker.field, targets);
          }}
        />
      )}
    </div>
  );
};

export default WorkflowFormView;
