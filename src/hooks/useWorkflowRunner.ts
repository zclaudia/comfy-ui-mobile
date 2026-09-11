/**
 * Shared workflow execution.
 *
 * Extracted from WorkflowEditor, which owns the complete path: the agent-draft
 * branch (`integration.execute`), the canvas-v2 branch (the official frontend
 * builds the prompt, so local seed handling must be skipped or the run
 * double-randomizes), seed control_after_generate, prompt submission and
 * tracking. WorkflowStackEditor had a simplified copy of the same flow; it now
 * calls this instead.
 *
 * Two behaviours are deliberately taken from the stack editor's copy rather
 * than the editor's:
 *
 *  - Seed changes are collected into a local map that is passed straight to
 *    createExecutionGraph. `widgetEditor.modifiedWidgetValues` is React state
 *    captured at render, so a seed randomized inside this very call was never
 *    visible to the graph the editor submitted — every run shipped the previous
 *    run's seed.
 *  - Linked form fields are unified after seed processing, so a pair of samplers
 *    exposed as one field really does receive one seed.
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import ComfyUIService from '@/infrastructure/api/ComfyApiClient';
import { convertGraphToAPI } from '@/infrastructure/api/ComfyApiFunctions';
import { createExecutionGraph } from '@/core/services/WorkflowExecutionService';
import { serializeGraph } from '@/core/services/WorkflowGraphService';
import { getActiveCanvasBridge } from '@/services/bridge/CanvasBridgeClient';
import { autoChangeSeed } from '@/shared/utils/seedProcessing';
import { applyLinkedFields, type FormGraphLike } from '@/shared/utils/mobileForm';
import { prepareExecutionModifications } from '@/shared/utils/executionModifications';

import type { IComfyJson } from '@/shared/types/app/IComfyJson';
import type { IComfyWorkflow } from '@/shared/types/app/IComfyWorkflow';
import type { MobileFormSpec } from '@/shared/types/app/IMobileForm';
import type { NodeWidgetModifications } from '@/shared/types/widgets/widgetModifications';
import type { PreparedWorkflowExecution } from '@/shared/types/comfy/IComfyAPI';

export interface RunnerWidgetEditor {
  modifiedWidgetValues: Map<number, NodeWidgetModifications>;
  getWidgetValue: (nodeId: number, paramName: string, originalValue: any) => any;
  setWidgetValue: (nodeId: number, paramName: string, value: any) => void;
}

export interface UseWorkflowRunnerOptions {
  /** Graph the prompt is built from. The editor passes its current session. */
  getGraph: () => any | null;
  /** Workflow object seed processing reads control_after_generate from. */
  getWorkflow: () => IComfyWorkflow | null;
  getNodeMetadata: () => any;
  widgetEditor: RunnerWidgetEditor;
  isConnected: boolean;
  workflowId?: string;
  workflowName?: string;
  /** Form spec whose linked fields are unified before submission. */
  getFormSpec?: () => MobileFormSpec | null;
  /** Agent-draft host; when present it owns submission entirely. */
  integration?: { execute: (canvas: IComfyJson) => Promise<void>; onError: (error: unknown) => void } | null;
  captureWorkflowJson?: () => Promise<IComfyJson>;
  /** True when the official canvas owns the graph. */
  officialCanvasEnabled?: boolean;
  onPromptSubmitted?: (promptId: string) => void;
}

export interface WorkflowRunner {
  isExecuting: boolean;
  execute: () => Promise<void>;
  interrupt: () => Promise<void>;
  clearQueue: () => Promise<void>;
  randomizeSeeds: (force?: boolean) => Promise<number>;
  /** Same as randomizeSeeds, but returns the individual changes for reporting. */
  randomizeSeedsDetailed: (force?: boolean) => Promise<Array<{ nodeId: number }>>;
  currentPromptIdRef: React.MutableRefObject<string | null>;
}

export const useWorkflowRunner = (options: UseWorkflowRunnerOptions): WorkflowRunner => {
  const { t } = useTranslation();
  const [isExecuting, setIsExecuting] = useState(false);
  const currentPromptIdRef = useRef<string | null>(null);
  // Read through refs so callers do not have to memoize every getter.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const prepareModifications = useCallback(async (forceRandomize = false) => {
    const { widgetEditor, getWorkflow, getNodeMetadata, getGraph, getFormSpec } = optionsRef.current;
    return prepareExecutionModifications({
      base: widgetEditor.modifiedWidgetValues,
      readBase: widgetEditor.getWidgetValue,
      writeThrough: widgetEditor.setWidgetValue,
      workflow: getWorkflow(),
      nodeMetadata: getNodeMetadata(),
      graph: getGraph() as FormGraphLike | null,
      formSpec: getFormSpec?.() ?? null,
      forceRandomize,
    });
  }, []);

  const execute = useCallback(async () => {
    const {
      integration, captureWorkflowJson, getGraph, getWorkflow, isConnected,
      officialCanvasEnabled, workflowId, workflowName, onPromptSubmitted,
    } = optionsRef.current;

    if (integration) {
      try {
        if (!captureWorkflowJson) throw new Error('captureWorkflowJson is required with an integration');
        await integration.execute(await captureWorkflowJson());
      } catch (error) {
        integration.onError(error);
      }
      return;
    }

    const graph = getGraph();
    const workflow = getWorkflow();
    if (!graph || !isConnected || !workflow) {
      toast.error(t('workflow.submitFailed'));
      return;
    }

    try {
      setIsExecuting(true);

      // Canvas v2 builds the prompt through the official frontend, which runs
      // its own seed handling right before graphToPrompt.
      const bridge = getActiveCanvasBridge();
      const useOfficialPrompt = !!officialCanvasEnabled && !!bridge?.isReady;

      let execution: PreparedWorkflowExecution;
      if (useOfficialPrompt && bridge) {
        const promptData = await bridge.getPrompt();
        execution = { prompt: promptData.output ?? {}, workflow: promptData.workflow };
      } else {
        const { modifications } = await prepareModifications(false);
        const executionGraph = createExecutionGraph(graph, modifications);
        const converted = convertGraphToAPI(executionGraph);
        execution = { prompt: converted.apiWorkflow, workflow: serializeGraph(executionGraph) };
      }

      const promptId = await ComfyUIService.executeWorkflow(execution, {
        workflowId: workflowId || 'workflow-editor',
        workflowName: workflowName || t('workflow.newWorkflowName'),
      });
      currentPromptIdRef.current = promptId;
      onPromptSubmitted?.(promptId);
    } catch (error) {
      console.error('Workflow execution failed:', error);
      toast.error(t('workflow.submitFailed'));
    } finally {
      setIsExecuting(false);
    }
  }, [prepareModifications, t]);

  const interrupt = useCallback(async () => {
    try {
      await ComfyUIService.interruptExecution();
    } catch (error) {
      console.error('INTERRUPT: Failed to interrupt:', error);
      toast.error(t('workflow.interruptFailed'));
    }
  }, [t]);

  const clearQueue = useCallback(async () => {
    try {
      await ComfyUIService.clearQueue();
      toast.success(t('workflow.queueCleared'));
    } catch (error) {
      console.error('Failed to clear queue:', error);
      toast.error(t('workflow.clearQueueFailed'));
    }
  }, [t]);

  /**
   * Manual "randomize seeds" button. Writes through the widget editor so the
   * change is visible and saveable, and unifies linked fields afterwards.
   */
  const randomizeSeedsDetailed = useCallback(async (force = true) => {
    const { widgetEditor, getWorkflow, getNodeMetadata, getGraph, getFormSpec } = optionsRef.current;
    const workflow = getWorkflow();
    if (!workflow) return [];
    const changes = await autoChangeSeed(
      workflow,
      getNodeMetadata(),
      { getWidgetValue: widgetEditor.getWidgetValue, setWidgetValue: widgetEditor.setWidgetValue },
      force,
    );
    applyLinkedFields(
      getGraph() as FormGraphLike | null,
      getFormSpec?.() ?? null,
      widgetEditor.getWidgetValue,
      widgetEditor.setWidgetValue,
    );
    return changes;
  }, []);

  const randomizeSeeds = useCallback(
    async (force = true) => (await randomizeSeedsDetailed(force)).length,
    [randomizeSeedsDetailed],
  );

  return { isExecuting, execute, interrupt, clearQueue, randomizeSeeds, randomizeSeedsDetailed, currentPromptIdRef };
};
