import { useEffect, useRef, useState } from 'react';
import { useChatSession, type ChatMessage } from '../chat/chatState.js';
import { Composer } from '../components/Composer.js';
import { IconButton } from '../components/IconButton.js';
import { MessageItem, type ThinkingStatus } from '../components/MessageItem.js';
import { TerminalPanel } from '../components/TerminalPanel.js';
import { useI18n, type Locale } from '../i18n/I18nProvider.js';
import { useLabFlag } from '../lab/labFlags.js';
import { api } from '../api/client.js';
import type { AgentMessage } from '../../shared/types.js';
import './ChatPage.css';

/** One user prompt and everything that followed it until the next prompt. */
interface ChatUnit {
  key: string;
  user: ChatMessage | null;
  rest: ChatMessage[];
}

function buildUnits(messages: ChatMessage[]): ChatUnit[] {
  const units: ChatUnit[] = [];
  for (const item of messages) {
    if (item.message.role === 'user') {
      units.push({ key: item.key, user: item, rest: [] });
    } else {
      const last = units[units.length - 1];
      if (last !== undefined) {
        last.rest.push(item);
      } else {
        // Resumed sessions may start mid-conversation; keep an orphan unit.
        units.push({ key: `orphan-${item.key}`, user: null, rest: [item] });
      }
    }
  }
  return units;
}

function formatDuration(ms: number, locale: Locale): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (locale === 'zh') {
    return `${pad(hours)}时${pad(minutes)}分${pad(seconds)}秒`;
  }
  return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

/** Extracts the assistant reply as plain markdown text (copy primitive). */
function extractAssistantMarkdown(message: AgentMessage): string {
  if (message.role !== 'assistant') {
    return '';
  }
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();
}

/** Items that belong in the collapsed tool cluster only.
 *  Assistant messages that also carry text/thinking must stay in the main
 *  stream — otherwise the moment a toolCall block is appended mid-stream the
 *  whole reply vanishes into the (default-collapsed) cluster, which looks
 *  like flickering "text appears then disappears until the run finishes". */
function isToolMessage(item: ChatMessage): boolean {
  if (item.message.role === 'toolResult' || item.message.role === 'bashExecution') {
    return true;
  }
  if (item.message.role === 'assistant') {
    const { content } = item.message;
    return content.length > 0 && content.every((block) => block.type === 'toolCall');
  }
  return false;
}

/** Tool-cluster collapse (P1-10 C3): all tool blocks of one prompt run fold
 *  into a single set with a tool-name list header. */
function ToolCluster({ items }: { items: ChatMessage[] }): React.JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const names = [
    ...new Set(
      items
        .map((item) => {
          if (item.message.role === 'toolResult') {
            return item.message.toolName;
          }
          if (item.message.role === 'bashExecution') {
            return 'bash';
          }
          if (item.message.role === 'assistant') {
            const call = item.message.content.find((block) => block.type === 'toolCall');
            return call?.type === 'toolCall' ? call.name : '';
          }
          return '';
        })
        .filter((name) => name.length > 0),
    ),
  ];
  return (
    <div className="tool-cluster" data-expanded={expanded}>
      <button
        type="button"
        className="tool-cluster-header mono"
        onClick={() => {
          setExpanded(!expanded);
        }}
        aria-expanded={expanded}
      >
        <span className="hico hico-rectangle-stack" aria-hidden="true" />
        <span>{t('workflow.tools', { names: names.join(' / ') })}</span>
        <span className="tool-cluster-chevron" aria-hidden="true">
          {expanded ? '−' : '+'}
        </span>
      </button>
      {expanded ? (
        <div className="tool-cluster-body">
          {items.map((item) => (
            <MessageItem key={item.key} message={item.message} isStreaming={item.isStreaming} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface ChatPageProps {
  onSessionChanged: () => void;
}

export function ChatPage({ onSessionChanged }: ChatPageProps): React.JSX.Element {
  const chat = useChatSession();
  const { t, locale } = useI18n();
  const settledNotify = useLabFlag('settledNotify');
  const simplifiedOutput = useLabFlag('simplifiedOutput');
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasRunningRef = useRef(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [collapsedUnits, setCollapsedUnits] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Simplified output: settled workflows auto-collapse; this set tracks the
  // ones the user explicitly expanded.
  const [userExpanded, setUserExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [chat.messages.length, chat.isAgentRunning]);

  // Refresh the model display when the model is cycled via Ctrl+Shift+L.
  useEffect(() => {
    const onCycled = (): void => {
      void chat.refreshState();
    };
    window.addEventListener('pihub:model-cycled', onCycled);
    return () => {
      window.removeEventListener('pihub:model-cycled', onCycled);
    };
  }, [chat]);

  // Browser notification when the agent settles after a run (lab switch).
  useEffect(() => {
    if (!settledNotify) {
      return;
    }
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = chat.isAgentRunning;
    if (wasRunning && !chat.isAgentRunning && 'Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(t('notify.settled.title'), { body: t('notify.settled.body') });
      } else if (Notification.permission === 'default') {
        void Notification.requestPermission().then((permission) => {
          if (permission === 'granted') {
            new Notification(t('notify.settled.title'), { body: t('notify.settled.body') });
          }
        });
      }
    }
  }, [chat.isAgentRunning, settledNotify, t]);

  const units = buildUnits(chat.messages);
  const lastUnit = units[units.length - 1];
  const runSummary = chat.lastRun;
  const thinkingStatus: ThinkingStatus =
    chat.isAgentRunning && lastUnit !== undefined && lastUnit.user !== null
      ? 'active'
      : runSummary !== null && runSummary.aborted
        ? 'interrupted'
        : 'done';

  const toggleCollapsed = (key: string): void => {
    if (simplifiedOutput) {
      setUserExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
      return;
    }
    setCollapsedUnits((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Branch at the bottom of an agent reply (P1-10 B): pi's fork RPC splits
  // before a user message, so forking the *next* user message after this
  // reply yields a branch that ends exactly at this reply. If no next user
  // message exists (this reply is the session leaf), clone forks at the leaf
  // — the same break point.
  const forkAtReply = async (entryId: string): Promise<void> => {
    try {
      const index = chat.messages.findIndex((item) => item.entryId === entryId);
      const nextUser = chat.messages
        .slice(index + 1)
        .find((item) => item.message.role === 'user' && item.entryId !== undefined);
      const response =
        nextUser?.entryId !== undefined
          ? await api.forkSession(nextUser.entryId)
          : await api.cloneSession();
      if (response.success) {
        onSessionChanged();
      }
    } catch {
      // chat state surfaces backend errors
    }
  };

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // Live elapsed timer for the running unit (1s tick; renders only while a
  // run is active so idle pages never pay the interval cost).
  const [, setNowTick] = useState(0);

  useEffect(() => {
    if (!chat.isAgentRunning) {
      return;
    }
    const timer = window.setInterval(() => {
      setNowTick((prev) => prev + 1);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [chat.isAgentRunning]);

  const runningElapsed =
    chat.isAgentRunning && chat.runStartedAt !== null ? Date.now() - chat.runStartedAt : 0;

  const copyReplyAsMarkdown = async (item: ChatMessage): Promise<void> => {
    try {
      const text = extractAssistantMarkdown(item.message);
      await navigator.clipboard.writeText(text);
      setCopiedKey(item.key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === item.key ? null : current));
      }, 1500);
    } catch {
      // clipboard unavailable; ignore
    }
  };

  return (
    <section className="chatpage">
      <div className="chatpage-scroll scroll-area" ref={scrollRef}>
        {chat.error !== null ? (
          <div className="chatpage-error mono" role="alert">
            {chat.error}
          </div>
        ) : null}
        {chat.retrying ? (
          <div className="chatpage-retry mono" role="status">
            <span className="hico hico-exclamationmark" aria-hidden="true" />
            {t('chat.retrying')}
          </div>
        ) : null}
        {chat.pendingSteer.length > 0 || chat.pendingFollowUp.length > 0 ? (
          <div className="chatpage-queue mono">
            {t('chat.queued', {
              steer: String(chat.pendingSteer.length),
              followUp: String(chat.pendingFollowUp.length),
            })}
          </div>
        ) : null}
        {chat.messages.length === 0 ? (
          <div className="chatpage-empty">
            <h2 className="panel-title">{t('chat.empty.title')}</h2>
            <p className="chatpage-empty-hint">{t('chat.empty.hint')}</p>
          </div>
        ) : (
          <div className="chatpage-stream">
            {units.map((unit, unitIndex) => {
              const isLast = unit === lastUnit;
              const isRunningUnit = isLast && chat.isAgentRunning && unit.user !== null;
              const isSettledUnit = isLast && !chat.isAgentRunning && runSummary !== null && unit.user !== null;
              const showSummary =
                (isRunningUnit || isSettledUnit) && unit.user !== null;
              // Simplified output auto-collapses settled workflows; the
              // "....." marker then hints that more content is folded.
              const autoCollapsed =
                simplifiedOutput && isSettledUnit && !userExpanded.has(unit.key);
              const collapsed =
                autoCollapsed || collapsedUnits.has(unit.key);
              return (
                <div
                  key={unit.key}
                  className="chat-unit"
                  data-collapsed={collapsed}
                >
                  {!collapsed ? (
                    <div className="chat-unit-body">
                      {unit.user !== null ? (
                        <MessageItem
                          message={unit.user.message}
                          isStreaming={false}
                        />
                      ) : null}
                      {(() => {
                        // Tool blocks of this run collapse into one set
                        // (P1-10 C3); thinking/text messages render inline.
                        const toolItems = unit.rest.filter(isToolMessage);
                        const nonToolItems = unit.rest.filter((item) => !isToolMessage(item));
                        return (
                          <>
                            {nonToolItems.map((item) => (
                              <MessageItem
                                key={item.key}
                                message={item.message}
                                isStreaming={item.isStreaming}
                                thinkingStatus={
                                  unitIndex === units.length - 1 ? thinkingStatus : 'done'
                                }
                              />
                            ))}
                            {toolItems.length > 0 ? <ToolCluster items={toolItems} /> : null}
                          </>
                        );
                      })()}
                    </div>
                  ) : null}
                  {(() => {
                    // Reply footer (P1-10 B / P1-11 B): branch at this reply's
                    // tree node + copy as markdown. Hidden until hover; pure
                    // icons with IconButton's hover tooltip labels.
                    const lastAssistant = [...unit.rest].reverse().find(
                      (item) => item.message.role === 'assistant',
                    );
                    const branchEntryId = lastAssistant?.entryId;
                    if (lastAssistant === undefined) {
                      return null;
                    }
                    return (
                      <div className="chat-unit-footer">
                        <IconButton
                          icon="hico-arrow-triangle-divide"
                          label={t('sidebar.newBranch')}
                          placement="top"
                          disabled={branchEntryId === undefined}
                          onClick={() => {
                            if (branchEntryId !== undefined) {
                              void forkAtReply(branchEntryId);
                            }
                          }}
                        />
                        <IconButton
                          icon="hico-square-on-square-fill"
                          label={
                            copiedKey === lastAssistant.key
                              ? t('chat.copied')
                              : t('chat.copyResult')
                          }
                          placement="top"
                          onClick={() => {
                            void copyReplyAsMarkdown(lastAssistant);
                          }}
                        />
                      </div>
                    );
                  })()}
                  {showSummary ? (
                    <div className="chat-unit-summary">
                      <button
                        type="button"
                        className="chat-unit-summary-line mono"
                        onClick={() => {
                          toggleCollapsed(unit.key);
                        }}
                        aria-expanded={!collapsed}
                        aria-label={t('workflow.collapse')}
                      >
                        {isRunningUnit ? (
                          <>
                            <span className="hico hico-waveform chat-unit-running" aria-hidden="true" />
                            <span>
                              {t('workflow.elapsed', {
                                time: formatDuration(runningElapsed, locale),
                              })}
                            </span>
                          </>
                        ) : runSummary !== null && runSummary.aborted ? (
                          <>
                            <span className="hico hico-exclamationmark chat-unit-aborted" aria-hidden="true" />
                            <span>{t('workflow.interrupted')}</span>
                          </>
                        ) : (
                          <>
                            <span className="hico hico-clock chat-unit-elapsed" aria-hidden="true" />
                            <span>
                              {t('workflow.elapsed', {
                                time: formatDuration(runSummary?.durationMs ?? 0, locale),
                              })}
                            </span>
                          </>
                        )}
                        <span className="chat-unit-chevron" aria-hidden="true">
                          {collapsed ? '>' : '>'}
                        </span>
                      </button>
                      {isSettledUnit || isRunningUnit ? (
                        <>
                          {/* Full-width divider line closing the workflow */}
                          <div className="chat-unit-divider" aria-hidden="true" />
                          {collapsed ? (
                            <div className="chat-unit-settle mono" aria-hidden="true">
                              .....
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {terminalOpen ? <TerminalPanel /> : null}
      <div className="chatpage-bottom">
        <button
          type="button"
          className="chatpage-terminal-toggle mono"
          onClick={() => {
            setTerminalOpen(!terminalOpen);
          }}
        >
          {terminalOpen ? '▾' : '▴'} {t('terminal.title')}
        </button>
        <Composer
          isAgentRunning={chat.isAgentRunning}
          rpcState={chat.rpcState}
          onSendPrompt={(text, images) => {
            void chat.sendPrompt(text, images);
          }}
          onSendSteer={(text) => {
            void chat.sendSteer(text);
          }}
          onAbort={() => {
            void chat.abort();
            window.dispatchEvent(new Event('pihub:run-aborted'));
          }}
          onSetModel={(provider, modelId) => {
            void chat.setModel(provider, modelId);
          }}
          onSetThinking={(level) => {
            void chat.setThinkingLevel(level);
          }}
        />
      </div>
    </section>
  );
}
