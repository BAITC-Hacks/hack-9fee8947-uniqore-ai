import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, Copy, ShieldCheck } from "lucide-react";
import {
  type Analysis,
  type Cluster,
  type GraphNode,
  amount,
  number,
  roles,
} from "./types";

const period = (start: string, end: string) => {
  const format = (value: string) => value.split("-").reverse().join(".");
  return `${format(start)}–${format(end)}`;
};

export function DatasetPassport({
  analysis,
  onNetwork,
}: {
  analysis: Analysis;
  onNetwork: () => void;
}) {
  const dataset = analysis.dataset;
  const verified = dataset?.verification.status === "passed";
  return (
    <section
      className="dataset-passport"
      aria-label="Данные и результат обработки"
    >
      <div className="passport-result">
        <div>
          <strong>Предоставленный набор</strong>
          <span>
            {analysis.summary.n_seeds} исходных клиентов{" "}
            <ArrowRight size={12} /> {number(analysis.summary.n_nodes)} узлов ·{" "}
            {number(analysis.summary.n_edges)} связей ·{" "}
            {number(analysis.summary.n_transactions)} операций
          </span>
        </div>
        <button onClick={onNetwork}>
          Обзор сети <ArrowRight size={13} />
        </button>
      </div>
      <div className="passport-meta">
        <span>
          {(
            dataset?.files.map((file) => file.name) || [
              "nodes.parquet",
              "edges.parquet",
              "transactions.parquet",
            ]
          ).join(" · ")}
        </span>
        <span
          className={
            verified ? "verification-passed" : "verification-unconfirmed"
          }
        >
          {verified && <ShieldCheck size={13} />}
          {verified
            ? "3 CSV проверены"
            : dataset?.verification.status === "failed"
              ? "Проверка не пройдена"
              : "Проверка не подтверждена"}
          {dataset?.full_run_seconds !== undefined &&
            ` · обработка и проверка ${dataset.full_run_seconds.toFixed(2)} с`}
        </span>
        <details className="passport-details">
          <summary>О наборе и запуске</summary>
          <div>
            <strong>
              Период:{" "}
              {period(
                analysis.summary.period_start,
                analysis.summary.period_end,
              )}
            </strong>
            <p>
              Расчёт уже выполнен командой запуска: исходные файлы → метрики →
              гипотезы ролей и групп → приоритеты → интерфейс и CSV.
            </p>
            <p>
              Замер включает обработку, запись и проверку CSV. Расчёт метрик:{" "}
              {(
                dataset?.calculation_seconds ?? analysis.elapsed_seconds
              ).toFixed(2)}{" "}
              с. Импорт библиотек, установка и открытие браузера в это время не
              входят.
            </p>
            <p>
              Весь набор: {analysis.summary.n_clusters} групп,{" "}
              {analysis.summary.n_isolated} клиентов без наблюдаемых связей.
              Роли и группы — гипотезы для проверки.
            </p>
            <small>
              Анализ {analysis.analysis_id} · алгоритм{" "}
              {analysis.algorithm_version}
            </small>
          </div>
        </details>
      </div>
    </section>
  );
}

const factors = [
  ["volume", "Объём", 35],
  ["bridge", "Посредничество", 25],
  ["seed_reach", "Связь с seed", 25],
  ["activity", "Активность", 15],
] as const;

export function PrioritySummary({ node }: { node: GraphNode }) {
  return (
    <section className="priority-summary" aria-label="Основания приоритета">
      <h3>Почему приоритет №{node.rank}</h3>
      <p>{node.why}</p>
      <dl>
        {factors.map(([key, label, weight]) => (
          <div key={key}>
            <dt>
              {label} <small>до {weight}</small>
            </dt>
            <dd>{((node.priority_factors[key] || 0) * 100).toFixed(1)}</dd>
          </div>
        ))}
      </dl>
      <small>
        Вклады в балл /100; округление может дать разницу 0,1. Приоритет и
        поддержка роли — разные оценки.
      </small>
    </section>
  );
}

export function ClusterCard({
  cluster,
  members,
  onSelect,
  onBack,
}: {
  cluster: Cluster;
  members: GraphNode[];
  onSelect: (gid: string) => void;
  onBack: () => void;
}) {
  const explanation = cluster.explanation;
  return (
    <>
      <div className="cluster-card-heading">
        <button className="back-link" onClick={onBack}>
          <ArrowLeft size={14} /> Вернуться к клиенту и очереди
        </button>
        <span className="section-label">КАРТОЧКА ГРУППЫ</span>
        <h2>Сообщество {String(cluster.cluster_id).padStart(2, "0")}</h2>
        <p>Все группы доступны в списке слева.</p>
      </div>
      <div className="dossier-scroll cluster-card-scroll">
        <dl className="cluster-facts">
          <div>
            <dt>Клиенты</dt>
            <dd>{cluster.n_nodes}</dd>
          </div>
          <div>
            <dt>Исходные seed</dt>
            <dd>{cluster.n_seed}</dd>
          </div>
          <div>
            <dt>Внутренний оборот</dt>
            <dd>{amount(cluster.sum_kzt_internal)} ₸</dd>
          </div>
          {explanation && (
            <>
              <div>
                <dt>В группу извне</dt>
                <dd>{amount(explanation.incoming_amount)} ₸</dd>
              </div>
              <div>
                <dt>Из группы наружу</dt>
                <dd>{amount(explanation.outgoing_amount)} ₸</dd>
              </div>
            </>
          )}
        </dl>
        <section className="cluster-purpose">
          <h3>{explanation?.purpose || "Гипотеза о назначении"}</h3>
          {!explanation && <p>{cluster.hypothesis}</p>}
          {explanation && (
            <>
              <h4>Основания</h4>
              <ul>
                {explanation.evidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <details>
                <summary>Правило и пороги</summary>
                <p>{explanation.rule}</p>
              </details>
              <details>
                <summary>Полный текст гипотезы в CSV</summary>
                <p>{cluster.hypothesis}</p>
              </details>
              <h4>Ограничения</h4>
              <ul className="cluster-limits">
                {explanation.limitations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
        </section>
        <section className="cluster-members" aria-label="Состав сообщества">
          <h3>Состав · {members.length} клиентов</h3>
          <p>По глобальному приоритету. Первые пять — ключевые узлы группы.</p>
          {members.map((node, index) => (
            <button key={node.gid} onClick={() => onSelect(node.gid)}>
              <span>
                <strong>{node.gid}</strong>
                <small>
                  {roles[node.role].label} · приоритет №{node.rank}
                  {index < 5 ? " · ключевой" : ""}
                </small>
              </span>
              <ArrowRight size={14} />
            </button>
          ))}
        </section>
      </div>
      <div className="dossier-footer">
        <ShieldCheck size={13} />
        <span>Группа переводов · гипотеза для проверки</span>
      </div>
    </>
  );
}

export function ReviewTools({
  nodes,
  analysisId,
  visibleCount,
}: {
  nodes: GraphNode[];
  analysisId: string;
  visibleCount: number;
}) {
  const [copied, setCopied] = useState("");
  const [fallback, setFallback] = useState("");
  const copy = async (onlyGids: boolean) => {
    const text = onlyGids
      ? nodes.map((node) => node.gid).join("\n")
      : [
          `Перечень для углублённой проверки · анализ ${analysisId}`,
          "Выбор аналитика; не оценка виновности и не глобальный топ-20.",
          ...nodes.map(
            (node, index) =>
              `${index + 1}. gid ${node.gid}\nОснование: ${node.why}\nСледующий шаг: ${node.next_action}`,
          ),
        ].join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(onlyGids ? "Полные gid скопированы" : "Перечень скопирован");
      setFallback("");
    } catch {
      setCopied("Выделите и скопируйте текст ниже");
      setFallback(text);
    }
  };
  return (
    <div className="review-list">
      <p>
        Ваш перечень для углублённой проверки. Сохраняется при переходах в этом
        анализе; после перезагрузки нужно выбрать клиентов заново.
      </p>
      {nodes.length ? (
        <>
          <p className="review-count">
            Показано {visibleCount} из {nodes.length}. Копирование включает весь
            перечень, в том числе скрытых фильтрами клиентов.
          </p>
          <div className="review-copy-actions">
            <button onClick={() => copy(false)}>
              <Copy size={13} /> Скопировать весь перечень ({nodes.length})
            </button>
            <button onClick={() => copy(true)}>Все полные gid</button>
          </div>
          {copied && (
            <p role="status" className="copy-status">
              <Check size={13} />
              {copied}
            </p>
          )}
          {fallback && (
            <textarea
              aria-label="Текст перечня для копирования"
              value={fallback}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
          )}
        </>
      ) : (
        <div className="review-empty">
          Нажмите «Добавить на проверку» в списке клиентов или досье. Здесь
          появятся выбранные вами клиенты с основаниями и следующими действиями.
        </div>
      )}
      <small>
        Анализ {analysisId} · перечень не меняет три обязательных CSV.
      </small>
    </div>
  );
}
