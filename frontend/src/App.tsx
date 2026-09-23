import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  Expand,
  FileText,
  Filter,
  Focus,
  GitBranch,
  Layers,
  LoaderCircle,
  Network,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  X,
  Minus,
  AlertTriangle,
  CornerDownRight,
} from "lucide-react";
import { Graph, GraphHandle } from "./Graph";
import {
  Analysis,
  Dossier,
  GraphEdge,
  GraphNode,
  Role,
  roles,
  amount,
  number,
  shortId,
} from "./types";

const pct = (n: number) => Math.round(n * 100);
const date = (value: string) => `${value.slice(-2)}.07`;
const emptyDays: [number, number] = [1, 31];
const fullAmount = (n: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n) + " ₸";

function RoleBadge({ node }: { node: GraphNode }) {
  const role = roles[node.role];
  return (
    <span
      className="role-badge"
      style={{ color: role.color, background: role.tint }}
    >
      <i style={{ background: role.color }} />
      {role.label}
    </span>
  );
}

export function App() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [nodeError, setNodeError] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [clusterFilter, setClusterFilter] = useState("all");
  const [seedOnly, setSeedOnly] = useState(false);
  const [depthFilter, setDepthFilter] = useState("all");
  const [direction, setDirection] = useState<"both" | "in" | "out">("both");
  const [showFilters, setShowFilters] = useState(false);
  const [leftTab, setLeftTab] = useState<"queue" | "clusters">("queue");
  const [scope, setScope] = useState<"ego" | "all">("ego");
  const [hops, setHops] = useState(1);
  const [colorBy, setColorBy] = useState<"role" | "cluster">("role");
  const [days, setDays] = useState<[number, number]>(emptyDays);
  const [visible, setVisible] = useState(0);
  const [detailTab, setDetailTab] = useState<
    "overview" | "transactions" | "assistant"
  >("overview");
  const [exportOpen, setExportOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [edge, setEdge] = useState<GraphEdge | null>(null);
  const [explanation, setExplanation] = useState<{
    text: string;
    label: string;
    notice?: string;
  } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [rowLimit, setRowLimit] = useState(50);
  const graph = useRef<GraphHandle>(null);
  const explanationRequest = useRef<AbortController | null>(null);
  const pendingEdge = useRef<GraphEdge | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/analysis", { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw Error("Не удалось загрузить анализ");
        return r.json();
      })
      .then((data: Analysis) => {
        setAnalysis(data);
        setSelected([...data.nodes].sort((a, b) => a.rank - b.rank)[0].gid);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    setDossier(null);
    setNodeError("");
    setExplanation(null);
    setEdge(pendingEdge.current);
    pendingEdge.current = null;
    setCopied(false);
    explanationRequest.current?.abort();
    setExplaining(false);
    fetch(`/api/nodes/${selected}`, { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw Error("Не удалось открыть досье");
        return r.json();
      })
      .then((data) => setDossier(data))
      .catch((e) => {
        if (e.name !== "AbortError") setNodeError(e.message);
      });
    return () => abort.abort();
  }, [selected]);
  const chosen = useMemo(
    () => analysis?.nodes.find((n) => n.gid === selected),
    [analysis, selected],
  );
  const allowed = useMemo(
    () =>
      new Set(
        (analysis?.nodes || [])
          .filter(
            (n) =>
              (roleFilter === "all" || n.role === roleFilter) &&
              (clusterFilter === "all" ||
                String(n.cluster_id) === clusterFilter) &&
              (!seedOnly || n.is_seed) &&
              (depthFilter === "all" || String(n.depth) === depthFilter),
          )
          .map((n) => n.gid),
      ),
    [analysis, roleFilter, clusterFilter, seedOnly, depthFilter],
  );
  const queue = useMemo(
    () =>
      (analysis?.nodes || [])
        .filter((n) => allowed.has(n.gid) && n.gid.includes(query.trim()))
        .sort((a, b) => a.rank - b.rank),
    [analysis, allowed, query],
  );
  const top = useMemo(
    () =>
      (analysis?.nodes || [])
        .filter((n) => n.rank <= 20)
        .sort((a, b) => a.rank - b.rank),
    [analysis],
  );
  const cluster = analysis?.clusters.find(
    (c) => c.cluster_id === chosen?.cluster_id,
  );
  const filteredTx = (dossier?.transactions || []).filter(
    (t) =>
      Number(t.date.slice(-2)) >= days[0] &&
      Number(t.date.slice(-2)) <= days[1] &&
      (!edge || (t.src === edge.src && t.dst === edge.dst)),
  );
  const selectedOutside = chosen && !allowed.has(selected);
  const hasFilters =
    roleFilter !== "all" ||
    clusterFilter !== "all" ||
    seedOnly ||
    depthFilter !== "all";
  const clearFilters = () => {
    setRoleFilter("all");
    setClusterFilter("all");
    setSeedOnly(false);
    setDepthFilter("all");
  };
  const choose = (gid: string) => {
    setSelected(gid);
    setEdge(null);
    setDetailTab("overview");
  };
  const onEdge = (e: GraphEdge) => {
    if (selected !== e.src && selected !== e.dst) {
      pendingEdge.current = e;
      setSelected(e.src);
    } else setEdge(e);
    setDetailTab("transactions");
  };
  const explain = async (question: "role" | "priority" | "missing") => {
    explanationRequest.current?.abort();
    const controller = new AbortController();
    explanationRequest.current = controller;
    setExplaining(true);
    setExplanation(null);
    const gid = selected;
    try {
      const r = await fetch(`/api/nodes/${gid}/explain`, {
        signal: controller.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!r.ok) throw Error();
      const data = await r.json();
      setExplanation(data);
    } catch {
      if (!controller.signal.aborted)
        setExplanation({
          text: "Не удалось получить пояснение. Все основания доступны на вкладке «Обзор».",
          label: "Ошибка запроса",
        });
    } finally {
      if (!controller.signal.aborted) setExplaining(false);
    }
  };
  if (!analysis)
    return (
      <div className="startup">
        <div className="brand-symbol">
          <Network size={29} />
        </div>
        <h1>Граф денег</h1>
        {error ? (
          <>
            <p>{error}</p>
            <button className="primary" onClick={() => location.reload()}>
              Повторить
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" />
            <p>Открываем картину связей…</p>
          </>
        )}
      </div>
    );

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand-symbol">
          <GitBranch size={25} />
        </div>
        <div className="rail-middle">
          <button
            className={
              leftTab === "queue" ? "rail-button active" : "rail-button"
            }
            title="Очередь и граф"
            onClick={() => setLeftTab("queue")}
          >
            <Network size={21} />
          </button>
          <button
            className={
              leftTab === "clusters" ? "rail-button active" : "rail-button"
            }
            title="Сообщества"
            onClick={() => setLeftTab("clusters")}
          >
            <Layers size={21} />
          </button>
        </div>
        <button
          className="rail-button"
          title="Метод и ограничения"
          onClick={() => setHelp(true)}
        >
          <CircleHelp size={21} />
        </button>
        <span className="rail-monogram">U.</span>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <a className="wordmark" href="/">
            uniqore<span>.ai</span>
          </a>
          <span className="header-divider" />
          <span className="product-name">Граф денег</span>
          <span className="workspace-pill">Рабочее пространство аналитика</span>
          <div className="header-right">
            <span className="local-status">
              <i />
              Локальный анализ
            </span>
            <button
              className="icon-button"
              title="О методе"
              onClick={() => setHelp(true)}
            >
              <CircleHelp size={18} />
            </button>
            <div className="export-wrap">
              <button
                className="primary export-button"
                onClick={() => setExportOpen(!exportOpen)}
              >
                <Download size={16} />
                Выгрузить
                <ChevronDown size={14} />
              </button>
              {exportOpen && (
                <div className="export-menu">
                  {[
                    ["nodes_roles.csv", "Все узлы и роли"],
                    ["clusters.csv", "Сообщества"],
                    ["top_nodes.csv", "Приоритетные узлы"],
                  ].map(([file, label]) => (
                    <a
                      key={file}
                      href={`/api/exports/${file}`}
                      download
                      onClick={() => setExportOpen(false)}
                    >
                      <FileText size={17} />
                      <span>
                        {label}
                        <small>{file}</small>
                      </span>
                      <ArrowUpRight size={14} />
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>
        <main>
          <section className="intro">
            <div>
              <div className="eyebrow">
                <span className="case-dot" />
                ФИНАНСОВЫЙ МОНИТОРИНГ<span className="slash">/</span>ДЕЛО
                07–2026
              </div>
              <h1>
                За переводами — связи<span>.</span>
              </h1>
              <p>
                Наблюдаемая структура сети. Обоснованные приоритеты для
                проверки.
              </p>
            </div>
            <div className="period-card">
              <span className="period-icon">
                <Activity size={19} />
              </span>
              <div>
                <small>ПЕРИОД НАБЛЮДЕНИЯ</small>
                <strong>01 — 31 июля 2026</strong>
              </div>
              <span className="period-tag">31 день</span>
            </div>
          </section>
          <section className="stats-grid">
            <div className="stat-card">
              <span className="stat-icon blue">
                <Users size={19} />
              </span>
              <div>
                <span>Клиенты в графе</span>
                <strong>{number(analysis.summary.n_nodes)}</strong>
              </div>
              <small>{number(analysis.summary.n_edges)} связей</small>
            </div>
            <div className="stat-card">
              <span className="stat-icon teal">
                <ArrowUpRight size={20} />
              </span>
              <div>
                <span>Объём переводов</span>
                <strong>
                  {amount(analysis.summary.total_amount)} <em>₸</em>
                </strong>
              </div>
              <small>{number(analysis.summary.n_transactions)} операций</small>
            </div>
            <div className="stat-card">
              <span className="stat-icon violet">
                <Focus size={19} />
              </span>
              <div>
                <span>Исходные клиенты</span>
                <strong>
                  {analysis.summary.n_seeds}
                  <em>seed</em>
                </strong>
              </div>
              <small>4 колена обхода</small>
            </div>
            <button
              className="stat-card boundary-stat"
              onClick={() => {
                clearFilters();
                setDepthFilter("4");
                setLeftTab("queue");
                setQuery("");
                setShowFilters(true);
              }}
            >
              <span className="stat-icon amber">
                <GitBranch size={19} />
              </span>
              <div>
                <span>На границе наблюдения</span>
                <strong>{analysis.summary.n_boundary}</strong>
              </div>
              <small>
                Нужны данные дальше
                <ArrowRight size={13} />
              </small>
            </button>
          </section>
          <section className="investigation">
            <aside className="queue-panel">
              <div className="queue-tabs">
                <button
                  className={leftTab === "queue" ? "active" : ""}
                  onClick={() => setLeftTab("queue")}
                >
                  Приоритеты <span>{top.length}</span>
                </button>
                <button
                  className={leftTab === "clusters" ? "active" : ""}
                  onClick={() => setLeftTab("clusters")}
                >
                  Сообщества
                </button>
              </div>
              <div className="queue-tools">
                <label className="search-box">
                  <Search size={15} />
                  <input
                    aria-label="Поиск по gid"
                    placeholder="Найти клиента по gid"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setRowLimit(50);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && queue[0]) choose(queue[0].gid);
                    }}
                  />
                  {query && (
                    <button title="Очистить поиск" onClick={() => setQuery("")}>
                      <X size={13} />
                    </button>
                  )}
                </label>
                <button
                  className={
                    hasFilters ? "filter-button applied" : "filter-button"
                  }
                  title="Фильтры"
                  onClick={() => setShowFilters(!showFilters)}
                >
                  <Filter size={15} />
                </button>
              </div>
              {showFilters && (
                <div className="filters">
                  <select
                    aria-label="Роль"
                    value={roleFilter}
                    onChange={(e) => setRoleFilter(e.target.value)}
                  >
                    <option value="all">Все роли</option>
                    {Object.entries(roles).map(([key, r]) => (
                      <option key={key} value={key}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Сообщество"
                    value={clusterFilter}
                    onChange={(e) => setClusterFilter(e.target.value)}
                  >
                    <option value="all">Все сообщества</option>
                    {analysis.clusters.map((c) => (
                      <option key={c.cluster_id} value={c.cluster_id}>
                        Сообщество {String(c.cluster_id).padStart(2, "0")} ·{" "}
                        {c.n_nodes}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Глубина"
                    value={depthFilter}
                    onChange={(e) => setDepthFilter(e.target.value)}
                  >
                    <option value="all">Любая глубина</option>
                    {[0, 1, 2, 3, 4].map((d) => (
                      <option key={d} value={d}>
                        {d === 0
                          ? "Seed · глубина 0"
                          : d === 4
                            ? "Граница · глубина 4"
                            : `${d}-е колено`}
                      </option>
                    ))}
                  </select>
                  <div className="filter-bottom">
                    <label>
                      <input
                        type="checkbox"
                        checked={seedOnly}
                        onChange={(e) => setSeedOnly(e.target.checked)}
                      />
                      Только seed
                    </label>
                    <button onClick={clearFilters}>Сбросить</button>
                  </div>
                </div>
              )}
              <div className="list-caption">
                <span>
                  {leftTab === "queue"
                    ? `${number(queue.length)} клиентов`
                    : `${analysis.clusters.length} сообществ`}
                </span>
                <span>{leftTab === "queue" ? "ПРИОРИТЕТ" : "УЗЛЫ"}</span>
              </div>
              <div className="queue-list">
                {leftTab === "queue" ? (
                  <>
                    {queue.slice(0, rowLimit).map((n) => (
                      <button
                        key={n.gid}
                        className={`queue-item ${n.gid === selected ? "selected" : ""}`}
                        onClick={() => choose(n.gid)}
                        title={n.gid}
                      >
                        <span className="rank">
                          {String(n.rank).padStart(2, "0")}
                        </span>
                        <div className="queue-node">
                          <strong>
                            {shortId(n.gid)}
                            {n.is_seed && <span className="seed-mini">S</span>}
                          </strong>
                          <span className="queue-role">
                            <i style={{ background: roles[n.role].color }} />
                            {roles[n.role].label}
                          </span>
                        </div>
                        <span className="queue-score">
                          {pct(n.priority_score)}
                          <i style={{ width: `${pct(n.priority_score)}%` }} />
                        </span>
                      </button>
                    ))}
                    {queue.length === 0 && (
                      <div className="empty-list">
                        Клиент не найден.
                        <br />
                        <button
                          onClick={() => {
                            clearFilters();
                            setQuery("");
                          }}
                        >
                          Сбросить поиск и фильтры
                        </button>
                      </div>
                    )}
                    {queue.length > rowLimit && (
                      <button
                        className="load-more"
                        onClick={() => setRowLimit(rowLimit + 50)}
                      >
                        Показать ещё 50
                      </button>
                    )}
                  </>
                ) : (
                  analysis.clusters
                    .slice()
                    .sort((a, b) => b.n_nodes - a.n_nodes)
                    .map((c) => (
                      <button
                        className={`cluster-item ${String(c.cluster_id) === clusterFilter ? "selected" : ""}`}
                        key={c.cluster_id}
                        onClick={() => {
                          setClusterFilter(String(c.cluster_id));
                          clearFilters();
                          setClusterFilter(String(c.cluster_id));
                          setScope("all");
                          choose(c.top_gids[0]);
                        }}
                      >
                        <span
                          className="cluster-glyph"
                          style={{
                            color: `hsl(${(c.cluster_id * 137.5) % 360},42%,50%)`,
                          }}
                        >
                          <Layers size={18} />
                        </span>
                        <div>
                          <strong>
                            Сообщество {String(c.cluster_id).padStart(2, "0")}
                          </strong>
                          <small>
                            {c.n_seed} seed · {amount(c.sum_kzt_internal)} ₸
                          </small>
                        </div>
                        <span>{c.n_nodes}</span>
                      </button>
                    ))
                )}
              </div>
              <div className="queue-footer">
                <ShieldCheck size={15} />
                <span>Приоритет проверки ≠ виновность</span>
              </div>
            </aside>
            <section className="graph-panel">
              <div className="graph-heading">
                <div>
                  <h2>Карта переводов</h2>
                  <span>
                    {visible} из {number(analysis.summary.n_nodes)} узлов
                  </span>
                </div>
                <div className="segmented">
                  <button
                    className={scope === "ego" ? "active" : ""}
                    onClick={() => setScope("ego")}
                  >
                    Окружение
                  </button>
                  <button
                    className={scope === "all" ? "active" : ""}
                    onClick={() => setScope("all")}
                  >
                    Вся сеть
                  </button>
                </div>
              </div>
              <div className="graph-toolbar">
                <div className="graph-pills">
                  <button
                    className={hops === 1 ? "active" : ""}
                    onClick={() => setHops(1)}
                    disabled={scope === "all"}
                  >
                    1 переход
                  </button>
                  <button
                    className={hops === 2 ? "active" : ""}
                    onClick={() => setHops(2)}
                    disabled={scope === "all"}
                  >
                    2 перехода
                  </button>
                </div>
                <label className="direction-select">
                  <select
                    aria-label="Направление связей"
                    disabled={scope === "all"}
                    value={direction}
                    onChange={(e) =>
                      setDirection(e.target.value as "both" | "in" | "out")
                    }
                  >
                    <option value="both">Все связи</option>
                    <option value="in">Входящие</option>
                    <option value="out">Исходящие</option>
                  </select>
                </label>
                <label className="color-select">
                  Цвет:
                  <select
                    aria-label="Цвет узлов"
                    value={colorBy}
                    onChange={(e) =>
                      setColorBy(e.target.value as "role" | "cluster")
                    }
                  >
                    <option value="role">роли</option>
                    <option value="cluster">сообщества</option>
                  </select>
                </label>
              </div>
              <div className="network-stage">
                <Graph
                  ref={graph}
                  nodes={analysis.nodes}
                  edges={analysis.edges}
                  selected={selected}
                  onSelect={choose}
                  onEdge={onEdge}
                  scope={scope}
                  direction={direction}
                  hops={hops}
                  allowed={allowed}
                  colorBy={colorBy}
                  days={days}
                  onCount={setVisible}
                />
                <div className="canvas-top-note">
                  <span className="live-dot" />
                  НАБЛЮДАЕМЫЕ СВЯЗИ
                </div>
                {chosen?.isolated && scope === "ego" && !selectedOutside && (
                  <div className="canvas-empty">
                    <GitBranch size={26} />
                    <strong>Узел без наблюдаемых связей</strong>
                    <span>
                      Клиент есть в seed. Переводы в выгрузке отсутствуют.
                    </span>
                  </div>
                )}
                {selectedOutside && (
                  <div className="canvas-empty">
                    <Filter size={25} />
                    <strong>Выбранный клиент вне фильтра</strong>
                    <button onClick={clearFilters}>Показать его связи</button>
                  </div>
                )}
                <div className="canvas-controls">
                  <button
                    title="Приблизить"
                    onClick={() => graph.current?.zoom(1.25)}
                  >
                    <Plus size={17} />
                  </button>
                  <button
                    title="Отдалить"
                    onClick={() => graph.current?.zoom(0.8)}
                  >
                    <Minus size={17} />
                  </button>
                  <span />
                  <button
                    title="Вписать граф"
                    onClick={() => graph.current?.fit()}
                  >
                    <Expand size={17} />
                  </button>
                </div>
                <div className="graph-legend">
                  {colorBy === "role" ? (
                    (Object.keys(roles) as Role[]).map((r) => (
                      <span key={r}>
                        <i style={{ background: roles[r].color }} />
                        {roles[r].label}
                      </span>
                    ))
                  ) : (
                    <span>Цвет — сообщество · группы в левой панели</span>
                  )}
                  <span>
                    <i className="seed-dot" />
                    Seed
                  </span>
                  <span title="Клиент четвёртого колена">
                    <i className="boundary-dot" />
                    Граница
                  </span>
                </div>
              </div>
              <div className="timeline">
                <div className="timeline-heading">
                  <span>
                    <Activity size={14} />
                    Активность клиента
                  </span>
                  <strong>
                    {String(days[0]).padStart(2, "0")} —{" "}
                    {String(days[1]).padStart(2, "0")} июля
                  </strong>
                  <button
                    onClick={() => setDays([1, 31])}
                    disabled={days[0] === 1 && days[1] === 31}
                  >
                    Сбросить
                  </button>
                </div>
                <div className="bars">
                  {Array.from({ length: 31 }, (_, i) => {
                    const d = dossier?.daily.find(
                      (d) => Number(d.date.slice(-2)) === i + 1,
                    );
                    const max = Math.max(
                      1,
                      ...(dossier?.daily || []).map((d) =>
                        Math.max(d.in_amount, d.out_amount),
                      ),
                    );
                    return (
                      <div
                        key={i}
                        className={
                          i + 1 < days[0] || i + 1 > days[1]
                            ? "day-bar muted"
                            : "day-bar"
                        }
                        title={`${i + 1} июля · вход ${fullAmount(d?.in_amount || 0)} · выход ${fullAmount(d?.out_amount || 0)}`}
                        onClick={() => setDays([i + 1, i + 1])}
                      >
                        <i
                          style={{
                            height: `${d ? (d.in_amount / max) * 100 : 0}%`,
                          }}
                        />
                        <b
                          style={{
                            height: `${d ? (d.out_amount / max) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="range-inputs">
                  <input
                    aria-label="Начало периода"
                    type="range"
                    min="1"
                    max="31"
                    value={days[0]}
                    onChange={(e) =>
                      setDays([
                        +e.target.value,
                        Math.max(+e.target.value, days[1]),
                      ])
                    }
                  />
                  <input
                    aria-label="Конец периода"
                    type="range"
                    min="1"
                    max="31"
                    value={days[1]}
                    onChange={(e) =>
                      setDays([
                        Math.min(days[0], +e.target.value),
                        +e.target.value,
                      ])
                    }
                  />
                </div>
                <div className="timeline-foot">
                  <span>01 июл</span>
                  <span>
                    <i className="in-dot" />
                    Вход
                    <i className="out-dot" />
                    Выход · роли рассчитаны за весь месяц
                  </span>
                  <span>31 июл</span>
                </div>
              </div>
            </section>
            <aside className="dossier-panel">
              {chosen && (
                <>
                  <div className="dossier-top">
                    <div className="eyebrow">
                      ДОСЬЕ КЛИЕНТА<span>#{chosen.rank}</span>
                    </div>
                    <div className="client-id">
                      <h2 title={selected}>{selected}</h2>
                      <button
                        className="icon-button"
                        title="Скопировать gid"
                        onClick={() => {
                          navigator.clipboard
                            .writeText(selected)
                            .then(() => setCopied(true));
                        }}
                      >
                        {copied ? <Check size={16} /> : <Copy size={16} />}
                      </button>
                    </div>
                    <div className="dossier-tags">
                      <RoleBadge node={chosen} />
                      <span className="depth-pill">
                        {chosen.depth === 0
                          ? "Исходный seed"
                          : `${chosen.depth}-е колено`}
                      </span>
                    </div>
                    <div className="priority-box">
                      <div>
                        <span>Приоритет проверки</span>
                        <strong>
                          {pct(chosen.priority_score)}
                          <small>/100</small>
                        </strong>
                      </div>
                      <div className="priority-track">
                        <i
                          style={{ width: `${pct(chosen.priority_score)}%` }}
                        />
                      </div>
                      <span className="support">
                        Поддержка гипотезы <b>{pct(chosen.role_score)}/100</b>
                        <CircleHelp
                          size={12}
                          aria-label="Эвристический балл, не вероятность"
                        />
                      </span>
                    </div>
                  </div>
                  <div className="detail-tabs">
                    {(
                      [
                        ["overview", "Обзор"],
                        ["transactions", "Операции"],
                        ["assistant", "Ассистент"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        className={detailTab === key ? "active" : ""}
                        onClick={() => {
                          setDetailTab(key);
                          if (key !== "transactions") setEdge(null);
                        }}
                      >
                        {key === "assistant" && <Sparkles size={13} />} {label}
                      </button>
                    ))}
                  </div>
                  <div className="dossier-scroll">
                    {nodeError && <div className="error-box">{nodeError}</div>}
                    {detailTab === "overview" && (
                      <>
                        <div className="section-label">ПОТОКИ ЗА ИЮЛЬ</div>
                        <div className="flow-grid">
                          <div>
                            <span>
                              <ArrowDownLeft size={14} />
                              Получено
                            </span>
                            <strong>
                              {amount(chosen.in_amount)} <small>₸</small>
                            </strong>
                            <small>от {chosen.in_degree} клиентов</small>
                          </div>
                          <div>
                            <span>
                              <ArrowUpRight size={14} />
                              Отправлено
                            </span>
                            <strong>
                              {amount(chosen.out_amount)} <small>₸</small>
                            </strong>
                            <small>{chosen.out_degree} получателям</small>
                          </div>
                        </div>
                        <div className="evidence-heading">
                          <span className="section-label">ПОЧЕМУ ЭТА РОЛЬ</span>
                          <span className="fact-tag">
                            <Check size={11} />
                            По данным
                          </span>
                        </div>
                        <p className="evidence-text">{chosen.evidence}</p>
                        <div className="fact-row">
                          <span>Достижимость от seed</span>
                          <strong>{chosen.seed_reach}</strong>
                        </div>
                        <div className="fact-row">
                          <span>Переводов: вход / выход</span>
                          <strong>
                            {chosen.in_tx} / {chosen.out_tx}
                          </strong>
                        </div>
                        <div className="fact-row">
                          <span>Объём с лагом 1–2 дня</span>
                          <strong>{amount(chosen.matched_amount)} ₸</strong>
                        </div>
                        <p className="micro-note">
                          Совместимость по времени не доказывает движение одних
                          и тех же денег.
                        </p>
                        <details className="priority-detail">
                          <summary>Из чего складывается приоритет</summary>
                          {Object.entries(chosen.priority_factors).map(
                            ([key, value]) => (
                              <div className="priority-factor" key={key}>
                                <span>
                                  {
                                    {
                                      volume: "Объём",
                                      bridge: "Посредничество",
                                      seed_reach: "Связь с seed",
                                      activity: "Активность",
                                    }[key]
                                  }
                                </span>
                                <i>
                                  <b
                                    style={{
                                      width: `${(value / 0.35) * 100}%`,
                                    }}
                                  />
                                </i>
                                <strong>{(value * 100).toFixed(1)}</strong>
                              </div>
                            ),
                          )}
                        </details>
                        <button
                          className="community-link"
                          onClick={() => {
                            setLeftTab("clusters");
                            clearFilters();
                            setClusterFilter(String(chosen.cluster_id));
                            setScope("all");
                          }}
                        >
                          <span className="community-icon">
                            <Layers size={18} />
                          </span>
                          <div>
                            <strong>
                              Сообщество{" "}
                              {String(chosen.cluster_id).padStart(2, "0")}
                            </strong>
                            <small>
                              {cluster?.n_nodes} узлов · {cluster?.n_seed} seed
                            </small>
                          </div>
                          <ChevronRight size={16} />
                        </button>
                        <div className="limit-box">
                          <AlertTriangle size={16} />
                          <div>
                            <strong>
                              {chosen.boundary
                                ? "Граница наблюдения"
                                : chosen.is_seed
                                  ? "Неполные входящие данные"
                                  : "Гипотеза для проверки"}
                            </strong>
                            <p>{chosen.limitations[0]}</p>
                          </div>
                        </div>
                        <div className="next-step">
                          <span className="section-label">СЛЕДУЮЩИЙ ШАГ</span>
                          <p>
                            <CornerDownRight size={16} />
                            {chosen.next_action}
                          </p>
                        </div>
                        {cluster && (
                          <details className="cluster-hypothesis">
                            <summary>Гипотеза сообщества</summary>
                            <p>{cluster.hypothesis}</p>
                          </details>
                        )}
                      </>
                    )}
                    {detailTab === "transactions" && (
                      <>
                        <div className="section-label">
                          ОПЕРАЦИИ · {filteredTx.length}
                          {edge && (
                            <button onClick={() => setEdge(null)}>
                              Все связи <X size={12} />
                            </button>
                          )}
                        </div>
                        <p className="micro-note">
                          {days[0]}–{days[1]} июля · суммы из исходной выгрузки
                        </p>
                        {edge && (
                          <div className="edge-banner">
                            {shortId(edge.src)} → {shortId(edge.dst)}
                            <br />
                            {fullAmount(
                              filteredTx.reduce((sum, t) => sum + t.amount, 0),
                            )}{" "}
                            · Операций за период: {filteredTx.length}
                          </div>
                        )}
                        {!dossier && !nodeError ? (
                          <LoaderCircle className="spin" />
                        ) : filteredTx.length === 0 ? (
                          <div className="empty-transactions">
                            В выбранном периоде операций нет.
                          </div>
                        ) : (
                          filteredTx.slice(0, 150).map((t, i) => (
                            <div key={t.ref + ":" + i} className="transaction">
                              <span
                                className={
                                  t.dst === selected ? "tx-in" : "tx-out"
                                }
                              >
                                {t.dst === selected ? (
                                  <ArrowDownLeft size={16} />
                                ) : (
                                  <ArrowUpRight size={16} />
                                )}
                              </span>
                              <div>
                                <strong>{fullAmount(t.amount)}</strong>
                                <button
                                  onClick={() =>
                                    choose(t.dst === selected ? t.src : t.dst)
                                  }
                                  title={t.dst === selected ? t.src : t.dst}
                                >
                                  {t.dst === selected ? "от" : "для"}{" "}
                                  {shortId(t.dst === selected ? t.src : t.dst)}
                                </button>
                                <small title={t.ref}>Источник: {t.ref}</small>
                              </div>
                              <time>{date(t.date)}</time>
                            </div>
                          ))
                        )}
                        {filteredTx.length > 150 && (
                          <p className="micro-note">
                            Показаны первые 150 операций. Сузьте период для
                            просмотра остальных.
                          </p>
                        )}
                      </>
                    )}
                    {detailTab === "assistant" && (
                      <div className="assistant">
                        <div className="assistant-symbol">
                          <Sparkles size={26} />
                        </div>
                        <h3>От фактов — к объяснению</h3>
                        <p>
                          {analysis.assistant_available
                            ? "AI помогает прочитать готовое досье. Расчёты остаются источником результата."
                            : "Локальные пояснения по рассчитанным фактам. Доступны без внешнего AI."}
                        </p>
                        <div className="assistant-questions">
                          {(
                            [
                              ["role", "Почему эта роль?"],
                              ["priority", "Почему этот приоритет?"],
                              ["missing", "Каких данных не хватает?"],
                            ] as const
                          ).map(([q, label]) => (
                            <button
                              key={q}
                              disabled={explaining}
                              onClick={() => explain(q)}
                            >
                              {label}
                              <ArrowUpRight size={14} />
                            </button>
                          ))}
                        </div>
                        {explaining && (
                          <div className="assistant-loading">
                            <LoaderCircle className="spin" size={17} />
                            Готовим пояснение…
                          </div>
                        )}
                        {explanation && (
                          <div className="assistant-answer">
                            <span>{explanation.label}</span>
                            <p>{explanation.text}</p>
                            {explanation.notice && (
                              <small>{explanation.notice}</small>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="dossier-footer">
                    <ShieldCheck size={13} />
                    <span>Структурная гипотеза · не оценка виновности</span>
                  </div>
                </>
              )}
            </aside>
          </section>
          <footer className="page-footer">
            <span>
              <i />
              Расчёт завершён за {analysis.elapsed_seconds.toFixed(2)} с
            </span>
            <span>Только наблюдаемые данные · без внешнего обогащения</span>
            <span>
              Анализ <code>{analysis.analysis_id.slice(0, 8)}</code> · v
              {analysis.algorithm_version}
            </span>
          </footer>
        </main>
      </div>
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="method-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Метод и ограничения"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              title="Закрыть"
              onClick={() => setHelp(false)}
            >
              <X size={20} />
            </button>
            <div className="eyebrow">ПРОЗРАЧНАЯ АНАЛИТИКА</div>
            <h2>Что показывает граф</h2>
            <p>
              Роли описывают структуру наблюдаемых переводов. Приоритет помогает
              выбрать следующего клиента для проверки, а поддержка гипотезы
              показывает силу рассчитанных признаков.
            </p>
            <div className="method-grid">
              {Object.entries(roles).map(([key, r]) => (
                <div key={key}>
                  <i style={{ background: r.color }} />
                  <strong>{r.label}</strong>
                  <span>{analysis.summary.roles[key] || 0} узлов</span>
                </div>
              ))}
            </div>
            <h3>Границы результата</h3>
            <ul>
              <li>
                Граф построен от {analysis.summary.n_seeds} seed по исходящим
                переводам на четыре колена.
              </li>
              <li>
                {analysis.summary.n_boundary} узла на границе: отсутствие выхода
                не означает, что деньги остались.
              </li>
              <li>
                {analysis.summary.n_isolated} изолированных клиентов сохранены в
                анализе.
              </li>
              <li>
                Только июль 2026, один банк, суммы от 5 000 ₸. Полные балансы
                неизвестны.
              </li>
              <li>
                Роли рассчитаны правилами; эталонной разметки для оценки
                accuracy нет.
              </li>
            </ul>
            <p className="micro-note">
              Seed обозначены ромбом, граница — пунктирным контуром. Цвет узла
              соответствует роли или сообществу.
            </p>
            <button className="primary" onClick={() => setHelp(false)}>
              К исследованию сети
              <ArrowRight size={16} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
