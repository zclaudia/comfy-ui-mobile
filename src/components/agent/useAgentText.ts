import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/** Translate known UI/system text; model-authored text and diagnostics remain intact. */
export function useAgentText() {
  const { t } = useTranslation();
  return useCallback((text: string, values: Record<string, string | number> = {}) => {
    const upload = /^上传失败 \((\d{3})\)$/.exec(text);
    if (upload) return t('agentUI.上传失败 ({{status}})', { status: upload[1] });
    const tool = /^工具 (.+) 未完成，请查看诊断或助手说明$/.exec(text);
    if (tool) return t('agentUI.工具 {{name}} 未完成，请查看诊断或助手说明', { name: tool[1] });
    const created = /^创建 ([\w.-]+) 工作流$/.exec(text);
    if (created) return t('agentUI.创建 {{name}} 工作流', { name: created[1] });
    const switched = /^切换为 ([\w.-]+) 工作流$/.exec(text);
    if (switched) return t('agentUI.切换为 {{name}} 工作流', { name: switched[1] });
    const restored = /^恢复版本 (\d+)$/.exec(text);
    if (restored) return t('agentUI.恢复版本 {{version}}', { version: restored[1] });
    const restoredFrom = /^从版本 (\d+) 恢复$/.exec(text);
    if (restoredFrom) return t('agentUI.从版本 {{version}} 恢复', { version: restoredFrom[1] });
    const newerDraft = /^创作已有新版本 (\d+)，请重新读取$/.exec(text);
    if (newerDraft) return t('agentUI.创作已有新版本 {{version}}，请查看服务器版本或另存本地修改。', { version: newerDraft[1] });
    return t(`agentUI.${text}`, { defaultValue: text, ...values });
  }, [t]);
}
