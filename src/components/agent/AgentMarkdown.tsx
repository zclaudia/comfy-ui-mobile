import { useAgentText } from './useAgentText';
import { Children, isValidElement, memo } from 'react';
import { CodeBlock } from '@zclaudia/agent-transcript-kit/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './AgentMarkdown.css';

/** Model-authored text is Markdown; generated media uses AgentMedia's authenticated URLs. */
export const AgentMarkdown = memo(function AgentMarkdown({ children }: { children: string }) {
  const at = useAgentText();
  return <div className="agent-markdown" data-agent-markdown>
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      pre: ({ children }) => {
        const code = Children.toArray(children)[0];
        if (!isValidElement<{ className?: string; children?: string }>(code)) return <pre>{children}</pre>;
        return <CodeBlock language={code.props.className?.replace(/^language-/, '') ?? 'text'}>{String(code.props.children ?? '').replace(/\n$/, '')}</CodeBlock>;
      },
      a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => <span>{alt || at('图片')}</span>,
      table: ({ children }) => <div className="agent-markdown-table" role="region" aria-label={at('表格，可横向滚动')} tabIndex={0}><table>{children}</table></div>,
    }}>{children}</Markdown>
  </div>;
});
