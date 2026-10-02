import { memo, useEffect, useState } from "react";
import { copyText, formatBytes, formatDuration } from "../lib/util";
import { useChat } from "../state/chat";
import { useServer } from "../state/server";
import { useSettings } from "../state/settings";
import { useToast } from "../state/toast";
import type { Message } from "../types";
import { Icon, Logo } from "./Icon";
import { Markdown } from "./Markdown";
import "./Message.css";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  return (
    <button
      type="button"
      className="icon-btn icon-btn-sm"
      aria-label={copied ? "Copied" : label}
      data-tooltip={copied ? "Copied" : label}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } else {
          toast("Couldn't access the clipboard", "error");
        }
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={15} />
    </button>
  );
}

function Reasoning({ text, ms, active }: { text: string; ms?: number; active: boolean }) {
  const { settings } = useSettings();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? (active || settings.expandReasoning);
  const label = active ? "Thinking…" : ms ? `Thought for ${formatDuration(ms)}` : "Thoughts";
  return (
    <div className={`reasoning${open ? " is-open" : ""}`}>
      <button type="button" className={`reasoning-toggle${active ? " is-active" : ""}`} aria-expanded={open} onClick={() => setUserOpen(!open)}>
        <Icon name="spark" size={15} />
        <span>{label}</span>
        <Icon name="chevronRight" size={14} className="reasoning-chevron" />
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  );
}

const CONTINUE_PROMPT = "Continue exactly where you stopped. Do not repeat anything you already wrote.";

/** Seconds since `since`, ticking while mounted (used only while waiting for the first token). */
function useElapsed(since: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}

function Waiting({ label, since }: { label: string; since: number }) {
  const s = useElapsed(since);
  return (
    <div className="typing" role="status">
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>
        Waiting for {label}… {s >= 5 && <span className="typing-elapsed">{s}s</span>}
        {s >= 12 && <span className="typing-note"> · NVIDIA is queuing this request; busy models can take a minute or two to start.</span>}
      </span>
    </div>
  );
}

function UserMessage({ message, conversationId }: { message: Message; conversationId: string }) {
  const { editAndResend, streaming } = useChat();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(message.content);

  const submit = () => {
    if (!value.trim() && !message.files?.length) return;
    setEditing(false);
    editAndResend(conversationId, message.id, value);
  };

  return (
    <div className="msg msg-user">
      {message.files && (
        <div className="msg-files">
          {message.files.map((f) => (
            <span key={f.name} className="file-chip" title={f.name}>
              <Icon name="file" size={15} />
              <span className="file-chip-name">{f.name}</span>
              <span className="file-chip-size">{formatBytes(f.size)}</span>
            </span>
          ))}
        </div>
      )}
      {editing ? (
        <div className="msg-edit">
          <textarea
            className="textarea"
            value={value}
            autoFocus
            rows={Math.min(10, Math.max(2, value.split("\n").length))}
            aria-label="Edit message"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="msg-edit-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={!!streaming}>
              Send
            </button>
          </div>
        </div>
      ) : (
        message.content && <div className="msg-bubble">{message.content}</div>
      )}
      {!editing && (
        <div className="msg-actions">
          {message.content && <CopyButton text={message.content} label="Copy message" />}
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="Edit and resend"
            data-tooltip={streaming ? "Wait for the response to finish" : "Edit and resend"}
            disabled={!!streaming}
            onClick={() => {
              setValue(message.content);
              setEditing(true);
            }}
          >
            <Icon name="pencil" size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function AssistantMessage({ message, conversationId, isLast }: { message: Message; conversationId: string; isLast: boolean }) {
  const { regenerate, send, streaming } = useChat();
  const { modelLabel } = useServer();
  const isStreaming = message.status === "streaming";
  const cutOff = !!message.content && ((message.status === "done" && message.finishReason === "length") || (message.status === "error" && message.errorCode === "max_duration"));
  const continueButton = isLast && cutOff && (
    <button type="button" className="btn btn-secondary btn-sm" disabled={!!streaming} onClick={() => send(CONTINUE_PROMPT, [])}>
      <Icon name="arrowDown" size={15} />
      Continue
    </button>
  );
  const thinkingNow = isStreaming && !message.content;
  const usage = message.usage;

  return (
    <div className="msg msg-assistant" aria-busy={isStreaming}>
      <div className="msg-meta">
        <span className="msg-avatar" aria-hidden="true">
          <Logo size={20} />
        </span>
        <span className="msg-model">{modelLabel(message.model)}</span>
      </div>

      {message.reasoning && <Reasoning text={message.reasoning} ms={message.reasoningMs} active={thinkingNow} />}

      {isStreaming && !message.content && !message.reasoning && <Waiting label={modelLabel(message.model)} since={message.createdAt} />}

      {message.content && <Markdown text={message.content} streaming={isStreaming} />}

      {message.status === "stopped" && (
        <p className="msg-note">
          <Icon name="stop" size={12} /> Stopped{message.content ? "" : " before any answer was written"}
        </p>
      )}
      {message.finishReason === "length" && message.status === "done" && (
        <div className="msg-note-row">
          <p className="msg-note">
            <Icon name="info" size={14} /> Reached the {message.maxTokens ? `${message.maxTokens.toLocaleString()}-token ` : ""}output limit.
          </p>
          {continueButton}
        </div>
      )}
      {message.status === "done" && !message.content && message.finishReason !== "length" && <p className="msg-note">The model returned an empty response.</p>}

      {message.status === "error" && (
        // Hitting the host's time limit isn't a failure: the text is kept and can be continued.
        <div className={`msg-error${message.errorCode === "max_duration" ? " is-paused" : ""}`} role="alert">
          <Icon name={message.errorCode === "max_duration" ? "info" : "alert"} size={18} />
          <div className="msg-error-text">
            <strong>{message.errorCode === "max_duration" ? "Paused at the time limit" : "Response failed"}</strong>
            <p>{message.error}</p>
          </div>
          {isLast && (
            <div className="msg-error-actions">
              {continueButton}
              <button type="button" className="btn btn-secondary btn-sm" disabled={!!streaming} onClick={() => regenerate(conversationId, message.id)}>
                <Icon name="refresh" size={15} />
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      {!isStreaming && (
        <div className="msg-actions msg-actions-assistant">
          {message.content && <CopyButton text={message.content} label="Copy response" />}
          {isLast && message.status !== "error" && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="Regenerate response"
              data-tooltip={streaming ? "Wait for the response to finish" : "Regenerate"}
              disabled={!!streaming}
              onClick={() => regenerate(conversationId, message.id)}
            >
              <Icon name="refresh" size={15} />
            </button>
          )}
          {usage?.completion != null && (
            <span
              className="msg-usage"
              title={`Prompt ${usage.prompt ?? "?"} tokens · Output ${usage.completion} tokens${usage.reasoning ? ` (${usage.reasoning} thinking)` : ""}${message.maxTokens ? ` · limit ${message.maxTokens.toLocaleString()}` : ""}`}
            >
              {usage.completion.toLocaleString()} tokens
              {usage.reasoning ? ` · ${usage.reasoning.toLocaleString()} thinking` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export const MessageItem = memo(function MessageItem({ message, conversationId, isLast }: { message: Message; conversationId: string; isLast: boolean }) {
  return message.role === "user" ? (
    <UserMessage message={message} conversationId={conversationId} />
  ) : (
    <AssistantMessage message={message} conversationId={conversationId} isLast={isLast} />
  );
});
