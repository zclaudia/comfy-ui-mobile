import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, ChevronRight, Home, Network, MessageSquare, SlidersHorizontal, Workflow } from 'lucide-react';
import { BackButton } from '@/components/navigation/PageHeader';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IComfyWorkflow, WorkflowNode } from '@/shared/types/app/IComfyWorkflow';
import { WorkflowHeaderProgressBar } from '@/components/execution/ExecutionProgressBar';
import { WorkflowSession } from '@/ui/store/globalStore';

// Custom morphing icon component
const SaveToCheckIcon: React.FC<{
  isSaving: boolean;
  isSuccess: boolean;
  size?: number
}> = ({ isSaving, isSuccess, size = 16 }) => {
  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <AnimatePresence mode="wait">
        {isSaving ? (
          <motion.div
            key="saving"
            initial={{ opacity: 0, rotate: -90 }}
            animate={{ opacity: 1, rotate: 0 }}
            exit={{ opacity: 0, rotate: 90 }}
            transition={{ duration: 0.13 }}
            className="absolute flex items-center justify-center"
            style={{ width: size, height: size }}
          >
            <Loader2 style={{ width: size, height: size }} className="animate-spin" />
          </motion.div>
        ) : isSuccess ? (
          <motion.svg
            key="success"
            className="absolute"
            style={{ width: size * 1.5, height: size * 1.5 }}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2, ease: "backOut" }}
          >
            <motion.path
              d="M9 12l2 2 4-4"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.25, delay: 0.05 }}
            />
          </motion.svg>
        ) : (
          <motion.svg
            key="save"
            className="absolute"
            style={{ width: size, height: size }}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ opacity: 0, scale: 1.2 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.13 }}
          >
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17,21 17,13 7,13 7,21" />
            <polyline points="7,3 7,8 15,8" />
          </motion.svg>
        )}
      </AnimatePresence>
    </div>
  );
};

interface WorkflowHeaderProps {
  workflow: IComfyWorkflow;
  selectedNode: WorkflowNode | null;
  hasUnsavedChanges?: boolean;
  isSaving?: boolean;
  onNavigateBack: () => void;
  onSaveChanges?: () => void;
  saveSucceeded?: boolean; // New prop to trigger checkmark animation
  sessionStack?: WorkflowSession[];
  onNavigateBreadcrumb?: (index: number) => void;
  onOpenChat?: () => void;
  chatActive?: boolean;
  /** Form/structure switch; omitted when the workflow has no usable form. */
  viewMode?: 'form' | 'structure';
  onViewModeChange?: (mode: 'form' | 'structure') => void;
}

export const WorkflowHeader: React.FC<WorkflowHeaderProps> = ({
  workflow,
  selectedNode,
  hasUnsavedChanges = false,
  isSaving = false,
  onNavigateBack,
  onSaveChanges,
  saveSucceeded = false,
  sessionStack,
  onNavigateBreadcrumb,
  onOpenChat,
  chatActive,
  viewMode,
  onViewModeChange,
}) => {
  const { t } = useTranslation();
  const breadcrumbRef = useRef<HTMLDivElement>(null);

  // Auto-scroll breadcrumbs to the right when session stack changes
  useEffect(() => {
    if (breadcrumbRef.current) {
      const container = breadcrumbRef.current;
      container.scrollLeft = container.scrollWidth;
    }
  }, [sessionStack]);

  const showSaveSuccess = saveSucceeded && !hasUnsavedChanges;

  return (
    <header className="absolute top-0 left-0 right-0 z-10 pwa-header">
      <div
        className="border-b border-white/[0.08] relative"
        style={{ background: 'rgba(11,12,15,0.86)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' }}
      >
        <div className="h-14 flex items-center gap-[11px] px-3 relative z-10">
          <BackButton onClick={onNavigateBack} />

          <div className="min-w-0 flex-1">
            {sessionStack && sessionStack.length > 1 ? (
              <div
                ref={breadcrumbRef}
                className="flex items-center space-x-1 overflow-x-auto no-scrollbar mask-gradient-left"
              >
                {sessionStack.map((session, index) => {
                  const isLast = index === sessionStack.length - 1;
                  const isRoot = index === 0;
                  return (
                    <div key={index} className="flex items-center flex-shrink-0">
                      {index > 0 && <ChevronRight className="w-3.5 h-3.5 text-[#4a5261] mx-0.5 flex-shrink-0" strokeWidth={2} />}
                      <button
                        onClick={() => !isLast && onNavigateBreadcrumb?.(index)}
                        disabled={isLast}
                        className={`flex items-center space-x-1 truncate transition-colors ${isLast
                          ? 'text-[14px] font-semibold text-[#e9ebef] cursor-default'
                          : 'text-[12.5px] font-medium text-[#71798a] hover:text-[#c8ccd4]'
                          }`}
                      >
                        <span className="truncate max-w-[300px]">{session.title || (isRoot ? workflow?.name : 'Subgraph')}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <h1 className="text-[14px] font-semibold text-[#e9ebef] leading-[1.25] truncate">
                {workflow?.name || t('workflow.newWorkflowName')}
              </h1>
            )}
            <div className="flex items-center gap-1.5 font-mono text-[9px] font-medium text-[#565d6b] tracking-[0.12em] uppercase mt-[3px]">
              <span>{viewMode === 'form' ? t('form.viewForm') : t('menu.graphView')}</span>
              {typeof workflow?.nodeCount === 'number' && workflow.nodeCount > 0 && (
                <>
                  <span className="text-[#31363f]">·</span>
                  <span className="text-[#5b8af5]">{workflow.nodeCount}N</span>
                </>
              )}
            </div>
          </div>

          {viewMode && onViewModeChange && (
            <div
              role="group"
              aria-label={t('form.viewSwitch')}
              className="flex shrink-0 items-center gap-[2px] rounded-[10px] border border-white/10 bg-[#14171e] p-[3px]"
            >
              <button
                data-e2e-view="form"
                aria-pressed={viewMode === 'form'}
                onClick={() => onViewModeChange('form')}
                title={t('form.viewForm')}
                className={`flex h-[26px] w-[30px] items-center justify-center rounded-[7px] transition-colors ${
                  viewMode === 'form' ? 'bg-[#3069f0] text-white' : 'text-[#8a919e]'
                }`}
              >
                <SlidersHorizontal className="h-[14px] w-[14px]" strokeWidth={2} />
              </button>
              <button
                data-e2e-view="structure"
                aria-pressed={viewMode === 'structure'}
                onClick={() => onViewModeChange('structure')}
                title={t('form.viewStructure')}
                className={`flex h-[26px] w-[30px] items-center justify-center rounded-[7px] transition-colors ${
                  viewMode === 'structure' ? 'bg-[#3069f0] text-white' : 'text-[#8a919e]'
                }`}
              >
                <Workflow className="h-[14px] w-[14px]" strokeWidth={2} />
              </button>
            </div>
          )}

          {onOpenChat && (
            <button
              data-e2e-action="open-chat"
              onClick={onOpenChat}
              className="h-9 px-3 shrink-0 flex items-center gap-1.5 rounded-[10px] border border-[#3069f0]/35 text-[12px] font-semibold text-[#5b8af5] relative"
              style={{ background: 'rgba(48,105,240,0.12)' }}
              title={t('workflow.openChat', '对话')}
            >
              <MessageSquare className="w-[15px] h-[15px]" strokeWidth={1.8} />
              <span>{t('workflow.openChat', '对话')}</span>
              {chatActive && <span className="absolute -top-[3px] -right-[3px] w-2 h-2 rounded-full bg-[#3069f0] border-[1.5px] border-[#0b0c0f]" />}
            </button>
          )}

          {/* Save Button Slot - Reserved space to prevent breadcrumb invasion */}
          <div className="w-9 h-9 flex items-center justify-end flex-shrink-0">
            <AnimatePresence>
              {(hasUnsavedChanges || isSaving || showSaveSuccess) && (
                <motion.div
                  initial={{ opacity: 0, x: 20, scale: 0.8 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.4 } }}
                  transition={{ duration: 0.3, ease: "backOut" }}
                >
                  <button
                    onClick={onSaveChanges}
                    disabled={isSaving || showSaveSuccess}
                    className={`w-9 h-9 flex items-center justify-center rounded-[10px] text-white transition-all ${showSaveSuccess
                      ? 'bg-[#34c77b]'
                      : isSaving
                        ? 'bg-[#34c77b]/60 cursor-not-allowed'
                        : 'bg-[#34c77b] hover:bg-[#3fd08a]'
                      }`}
                    style={showSaveSuccess ? undefined : { boxShadow: '0 2px 10px rgba(52,199,123,0.35)' }}
                    title={showSaveSuccess ? t('common.saved') : isSaving ? t('common.saving') : t('workflow.saveChanges')}
                  >
                    <SaveToCheckIcon
                      isSaving={isSaving}
                      isSuccess={showSaveSuccess}
                      size={16}
                    />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Execution Progress Bar */}
        <WorkflowHeaderProgressBar />
      </div>
    </header>
  );
};
