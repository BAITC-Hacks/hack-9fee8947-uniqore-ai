import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  KeyRound,
  LoaderCircle,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  askOpenAI,
  buildAssistantFacts,
  OPENAI_MODEL,
} from "./openaiAssistant";
import type { ChatMessage } from "./openaiAssistant";
import type { GraphNode } from "./types";

export function AssistantKeyDialog({
  open,
  connected,
  onClose,
  onConnect,
  onRemove,
}: {
  open: boolean;
  connected: boolean;
  onClose: () => void;
  onConnect: (key: string) => void;
  onRemove: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    if (input.current) input.current.value = "";
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const close = () => {
    if (input.current) input.current.value = "";
    setError("");
    onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="modal-backdrop"
      aria-labelledby="assistant-key-title"
      aria-describedby="assistant-key-privacy"
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section className="method-modal assistant-key-modal">
        <button
          className="modal-close icon-button"
          aria-label="Закрыть подключение OpenAI"
          onClick={close}
        >
          <X size={20} />
        </button>
        <div className="eyebrow">АССИСТЕНТ TYUIN</div>
        <h2 id="assistant-key-title">
          {connected ? "OpenAI: ключ задан" : "Подключить OpenAI"}
        </h2>
        <p id="assistant-key-privacy">
          API-ключ используется локально на фронтенде и хранится только в памяти
          этой страницы. Он не отправляется на сервер Tyuin и не сохраняется в
          хранилище браузера. После перезагрузки страницы ключ будет удалён —
          приложение нигде его не сохраняет.
        </p>
        <div className="assistant-privacy-note">
          <ShieldCheck size={18} />
          <p>
            При отправке вопроса браузер обращается напрямую к OpenAI: передаёт
            ключ для доступа, ваш вопрос, историю текущего чата и факты
            выбранного клиента. Действуют тарифы и{" "}
            <a
              href="https://developers.openai.com/api/docs/guides/your-data"
              target="_blank"
              rel="noreferrer"
            >
              правила обработки данных OpenAI
            </a>
            .
          </p>
        </div>
        <p>
          Автоматический контекст содержит роль, приоритет, метрики и
          ограничения — без исходных идентификаторов и отдельных операций. Текст
          ваших вопросов отправляется как введён.
        </p>
        {connected ? (
          <>
            <p className="assistant-key-confirmation">
              <KeyRound size={15} /> Ключ задан только в этой вкладке. Доступ
              проверяется при отправке вопроса.
            </p>
            <button
              className="primary"
              onClick={() => {
                onRemove();
                close();
              }}
            >
              <Trash2 size={15} /> Удалить ключ
            </button>
          </>
        ) : (
          <form
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              const key = input.current?.value.trim() || "";
              if (!key || /[^\x21-\x7e]/.test(key)) {
                setError("Введите API-ключ без пробелов.");
                return;
              }
              if (input.current) input.current.value = "";
              onConnect(key);
              close();
            }}
          >
            <label htmlFor="openai-api-key">OpenAI API key</label>
            <input
              ref={input}
              id="openai-api-key"
              type="password"
              placeholder="sk-…"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              required
              maxLength={512}
              aria-describedby="assistant-key-privacy"
              aria-invalid={Boolean(error)}
            />
            {error && (
              <p className="error-box" role="alert">
                {error}
              </p>
            )}
            <div className="assistant-dialog-actions">
              <button className="primary" type="submit">
                <KeyRound size={15} /> Подключить
              </button>
              <button type="button" onClick={close}>
                Пока без AI
              </button>
            </div>
          </form>
        )}
      </section>
    </dialog>
  );
}

export function AssistantPanel({
  apiKey,
  node,
  ready,
  period,
  onConnect,
  onRemove,
  onFacts,
}: {
  apiKey: string;
  node: GraphNode;
  ready: boolean;
  period: { start: string; end: string };
  onConnect: () => void;
  onRemove: () => void;
  onFacts: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const latestAnswer = useRef<HTMLDivElement>(null);

  // This panel is keyed by analysis/client and unmounted when leaving the tab.
  // Deleting or changing a key also invalidates every pending reply immediately.
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setMessages([]);
    if (!apiKey) setDraft("");
    setPending("");
    setError("");
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [apiKey]);
  useEffect(() => {
    if (messages.length)
      latestAnswer.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);

  const send = async (question: string) => {
    const text = question.trim();
    if (!text || request.current) return;
    if (!apiKey) {
      onConnect();
      return;
    }
    if (!ready) return;
    const controller = new AbortController();
    request.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 45000);
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setPending(text);
    setDraft("");
    setError("");
    try {
      const answer = await askOpenAI({
        apiKey,
        facts: buildAssistantFacts(node, period),
        messages: next,
        signal: controller.signal,
      });
      if (request.current === controller && !controller.signal.aborted) {
        setMessages(
          [...next, { role: "assistant" as const, content: answer }].slice(-24),
        );
      }
    } catch (failure) {
      if (request.current !== controller) return;
      if (timedOut)
        setError(
          "OpenAI не ответил за 45 секунд. Попробуйте отправить вопрос ещё раз.",
        );
      else if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Не удалось получить ответ. Попробуйте ещё раз.",
        );
      setDraft(text);
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        setPending("");
      }
    }
  };
  const stop = () => {
    request.current?.abort();
    request.current = null;
    setDraft(pending);
    setPending("");
  };

  return (
    <div className="assistant">
      <div className={`assistant-connection ${apiKey ? "connected" : ""}`}>
        <span>
          <KeyRound size={14} />
          {apiKey ? "Ключ задан в этой вкладке" : "OpenAI не подключён"}
        </span>
        {apiKey ? (
          <button onClick={onRemove} title="Удалить ключ и очистить чат">
            <Trash2 size={13} /> Удалить ключ
          </button>
        ) : (
          <button onClick={onConnect}>Подключить</button>
        )}
      </div>
      <div className="assistant-symbol">
        <Sparkles size={26} />
      </div>
      <h3>От фактов — к объяснению</h3>
      <p>
        Задайте вопрос о роли, приоритете или ограничениях выбранного клиента.
        Ассистент использует факты за весь период набора и не меняет результаты
        анализа.
      </p>
      <button className="assistant-context" onClick={onFacts}>
        Досье клиента {node.gid} <ArrowUpRight size={13} />
      </button>
      <div className="assistant-questions">
        {[
          "Почему эта роль?",
          "Почему этот приоритет?",
          "Каких данных не хватает?",
        ].map((question) => (
          <button
            key={question}
            disabled={Boolean(pending) || (Boolean(apiKey) && !ready)}
            onClick={() => void send(question)}
          >
            {question}
            <ArrowUpRight size={14} />
          </button>
        ))}
      </div>
      <div
        className="assistant-messages"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {messages.map((message, index) => (
          <div
            key={index}
            ref={index === messages.length - 1 ? latestAnswer : undefined}
            className={`assistant-message ${message.role}`}
          >
            <span>
              {message.role === "user" ? "Вы" : `OpenAI · ${OPENAI_MODEL}`}
            </span>
            <p>{message.content}</p>
            {message.role === "assistant" && (
              <button onClick={onFacts}>
                Сверить с досье клиента <ArrowUpRight size={12} />
              </button>
            )}
          </div>
        ))}
        {pending && (
          <>
            <div className="assistant-message user">
              <span>Вы</span>
              <p>{pending}</p>
            </div>
            <div className="assistant-loading" role="status">
              <LoaderCircle className="spin" size={17} />
              Готовим ответ…<button onClick={stop}>Остановить</button>
            </div>
          </>
        )}
      </div>
      {error && (
        <div className="error-box assistant-error" role="alert">
          {error} <button onClick={onConnect}>Настройки ключа</button>
        </div>
      )}
      <form
        className="assistant-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <label htmlFor="assistant-question">Ваш вопрос</label>
        <textarea
          id="assistant-question"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="Что стоит проверить у этого клиента?"
          disabled={Boolean(pending)}
        />
        <button
          className="primary"
          type="submit"
          disabled={
            !draft.trim() || Boolean(pending) || (Boolean(apiKey) && !ready)
          }
        >
          <Send size={14} />
          {apiKey ? "Отправить" : "Подключить и продолжить"}
        </button>
      </form>
      <p className="assistant-caption">
        {apiKey
          ? "Ключ исчезнет при обновлении страницы. "
          : "Для AI-ответов нужен ваш OpenAI API key. "}
        История чата очищается при смене клиента или вкладки. AI может ошибаться
        — сверяйте ответ с фактами.
      </p>
      <details className="assistant-local">
        <summary>Локальные пояснения · без API</summary>
        <h4>Почему эта роль?</h4>
        <p>{node.evidence}</p>
        <h4>Почему этот приоритет?</h4>
        <p>{node.why}</p>
        <h4>Каких данных не хватает?</h4>
        <p>
          {node.limitations.join(" ")} {node.next_action}
        </p>
      </details>
    </div>
  );
}
