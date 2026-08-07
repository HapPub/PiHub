import { useState } from 'react';
import type { AgentMessage, ContentBlock } from '../../shared/types.js';
import { Markdown } from './Markdown.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { useLabFlag } from '../lab/labFlags.js';
import './MessageItem.css';

export type ThinkingStatus = 'active' | 'done' | 'interrupted';

function ToolCallBlock({
  block,
}: {
  block: Extract<ContentBlock, { type: 'toolCall' }>;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const argumentsText = JSON.stringify(block.arguments, null, 2);

  return (
    <div className="toolcall">
      <button
        type="button"
        className="toolcall-header"
        onClick={() => {
          setExpanded(!expanded);
        }}
        aria-expanded={expanded}
      >
        <span className="toolcall-name mono">{block.name}</span>
        <span className="toolcall-chevron" aria-hidden="true">
          {expanded ? '−' : '+'}
        </span>
      </button>
      <div className="collapse-region" data-collapsed={!expanded}>
        <div className="collapse-region-inner">
          <pre className="toolcall-args">{argumentsText}</pre>
        </div>
      </div>
    </div>
  );
}

function ThinkingBlock({
  text,
  status,
  animate,
}: {
  text: string;
  status: ThinkingStatus;
  animate: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const label =
    status === 'active'
      ? t('thinking.active')
      : status === 'interrupted'
        ? t('thinking.interrupted')
        : t('thinking.done');
  const iconClass =
    status === 'interrupted' ? 'hico-exclamationmark' : 'hico-waveform';

  if (status === 'active') {
    // Keep the per-character label animation, but also show the accumulating
    // thinking text — hiding it made long reasoning turns look like the
    // reply was flickering empty until settle.
    return (
      <div className="thinking thinking-active" data-anim={animate} data-expanded={true}>
        <div className="thinking-toggle" aria-live="polite">
          <span className={`hico ${iconClass} thinking-icon`} aria-hidden="true" />
          <span className="thinking-label mono" aria-hidden="true">
            {label.split('').map((char, index) => (
              <span
                key={index}
                className="thinking-char"
                style={{ animationDelay: `${String(index * 0.18)}s` }}
              >
                {char}
              </span>
            ))}
          </span>
          <span className="thinking-label mono thinking-sr">{label}</span>
        </div>
        {text.trim().length > 0 ? (
          <div className="thinking-body thinking-body-live">{text}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="thinking" data-expanded={expanded} data-status={status}>
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => {
          setExpanded(!expanded);
        }}
        aria-expanded={expanded}
      >
        <span className={`hico ${iconClass} thinking-icon`} aria-hidden="true" />
        <span className="thinking-label mono">{label}</span>
        <span className="hico hico-chevron-down thinking-chevron" aria-hidden="true" />
      </button>
      <div className="collapse-region" data-collapsed={!expanded}>
        <div className="collapse-region-inner">
          <div className="thinking-body">{text}</div>
        </div>
      </div>
    </div>
  );
}

function ImageBlock({
  block,
}: {
  block: Extract<ContentBlock, { type: 'image' }>;
}): React.JSX.Element | null {
  const src = block.url ?? (block.data !== undefined ? `data:${block.mimeType ?? 'image/png'};base64,${block.data}` : undefined);
  if (src === undefined) {
    return null;
  }
  return <img className="message-image" src={src} alt="attachment" />;
}

function ContentBlocks({
  blocks,
  thinkingStatus,
  animate,
}: {
  blocks: ContentBlock[];
  thinkingStatus: ThinkingStatus;
  animate: boolean;
}): React.JSX.Element {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'text':
            return <Markdown key={index} text={block.text} />;
          case 'thinking':
            return (
              <ThinkingBlock
                key={index}
                text={block.thinking}
                status={thinkingStatus}
                animate={animate}
              />
            );
          case 'toolCall':
            return <ToolCallBlock key={index} block={block} />;
          case 'image':
            return <ImageBlock key={index} block={block} />;
        }
      })}
    </>
  );
}

function UserMessageView({ message }: { message: Extract<AgentMessage, { role: 'user' }> }): React.JSX.Element {
  const content = message.content;
  if (typeof content === 'string') {
    return (
      <div className="user-bubble">
        <Markdown text={content} />
      </div>
    );
  }
  return (
    <div className="user-bubble">
      <ContentBlocks blocks={content} thinkingStatus="done" animate={false} />
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  thinkingStatus,
  animate,
}: {
  message: Extract<AgentMessage, { role: 'assistant' }>;
  isStreaming: boolean;
  thinkingStatus: ThinkingStatus;
  animate: boolean;
}): React.JSX.Element {
  return (
    <div className="assistant-body" data-streaming={isStreaming}>
      <ContentBlocks blocks={message.content} thinkingStatus={thinkingStatus} animate={animate} />
      {isStreaming && animate ? <span className="stream-cursor" aria-hidden="true" /> : null}
    </div>
  );
}

function ToolResultView({ message }: { message: Extract<AgentMessage, { role: 'toolResult' }> }): React.JSX.Element {
  const compactTools = useLabFlag('compactTools');
  const [expanded, setExpanded] = useState(!compactTools);
  const text = message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();
  const preview = text.length > 400 ? `${text.slice(0, 400)}…` : text;

  return (
    <div className="toolresult" data-error={message.isError}>
      <button
        type="button"
        className="toolresult-header"
        onClick={() => {
          setExpanded(!expanded);
        }}
        aria-expanded={expanded}
      >
        <span className="toolresult-name mono">{message.toolName}</span>
        <span className="toolresult-status mono">{message.isError ? 'error' : 'ok'}</span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      <div className="collapse-region" data-collapsed={!expanded}>
        <div className="collapse-region-inner">
          <pre className="toolresult-output">{preview}</pre>
        </div>
      </div>
    </div>
  );
}

function BashExecutionView({ message }: { message: Extract<AgentMessage, { role: 'bashExecution' }> }): React.JSX.Element {
  return (
    <div className="toolresult">
      <div className="toolresult-header">
        <span className="toolresult-name mono">bash</span>
        <span className="toolresult-status mono">exit {String(message.exitCode)}</span>
      </div>
      <pre className="toolresult-output">{message.output}</pre>
    </div>
  );
}

interface MessageItemProps {
  message: AgentMessage;
  isStreaming: boolean;
  thinkingStatus?: ThinkingStatus;
}

export function MessageItem({
  message,
  isStreaming,
  thinkingStatus = 'done',
}: MessageItemProps): React.JSX.Element {
  const streamAnimation = useLabFlag('streamAnimation');
  switch (message.role) {
    case 'user':
      return (
        <div className="message message-user">
          <UserMessageView message={message} />
        </div>
      );
    case 'assistant':
      return (
        <div className="message message-assistant">
          <AssistantMessageView
            message={message}
            isStreaming={isStreaming}
            thinkingStatus={thinkingStatus}
            animate={streamAnimation}
          />
        </div>
      );
    case 'toolResult':
      return (
        <div className="message message-tool">
          <ToolResultView message={message} />
        </div>
      );
    case 'bashExecution':
      return (
        <div className="message message-tool">
          <BashExecutionView message={message} />
        </div>
      );
  }
}
