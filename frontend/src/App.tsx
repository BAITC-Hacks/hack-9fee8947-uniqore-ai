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
  FileUp,
  Filter,
  GitBranch,
  Layers,
  KeyRound,
  LoaderCircle,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  X,
  Minus,
  AlertTriangle,
  CornerDownRight,
} from "lucide-react";
import { Graph, GraphHandle } from "./Graph";
import { DatasetUpload } from "./DatasetUpload";
import {
  datasetFetch,
  DatasetApiError,
  readDatasetSession,
  writeDatasetSession,
} from "./dataset";
import {
  calendarDay,
  displayDate as date,
  displayPeriod,
  inDateRange,
  isoDay,
  timelineBins,
} from "./dateRange";
import { ClientRow } from "./ClientRow";
import { RoleExplanation } from "./RoleExplanation";
import { AssistantKeyDialog, AssistantPanel } from "./Assistant";
import {
  DatasetPassport,
  PrioritySummary,
  ClusterCard,
  ReviewTools,
} from "./ScenarioPanels";
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
      {node.role === "unknown" ? role.label : `Гипотеза: ${role.label}`}
    </span>
  );
}

export function App() {
  const [datasetId, setDatasetId] = useState(readDatasetSession);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [expired, setExpired] = useState(false);
  const [notice, setNotice] = useState("");
  const release = async (id: string) => {
    if (!id) return;
    try {
      await datasetFetch("/api/datasets/current", id, { method: "DELETE" });
    } catch (caught) {
      if (!(caught instanceof DatasetApiError && caught.status === 410))
        setNotice(
          "Предыдущий временный набор не удалось удалить с сервера. Он станет недоступен по истечении часа или при перезапуске сервера.",
        );
    }
  };
  const switchDataset = (id: string) => {
    const previous = datasetId;
    writeDatasetSession(id);
    setDatasetId(id);
    setExpired(false);
    setNotice("");
    setUploadOpen(false);
    if (previous !== id) void release(previous);
  };
  return (
    <>
      <Workbench
        key={datasetId || "startup"}
        datasetId={datasetId}
        expired={expired}
        notice={notice}
        onExpired={() => setExpired(true)}
        onUpload={() => setUploadOpen(true)}
        onRestore={() => switchDataset("")}
      />
      {uploadOpen && (
        <DatasetUpload
          onClose={() => setUploadOpen(false)}
          onUploaded={switchDataset}
        />
      )}
    </>
  );
}

function Workbench({
  datasetId,
  expired,
  notice,
  onExpired,
  onUpload,
  onRestore,
}: {
  datasetId: string;
  expired: boolean;
  notice: string;
  onExpired: () => void;
  onUpload: () => void;
  onRestore: () => void;
}) {
  const requestDataset = async (url: string, options: RequestInit = {}) => {
    try {
      return await datasetFetch(url, datasetId, options);
    } catch (caught) {
      if (caught instanceof DatasetApiError && caught.status === 410)
        onExpired();
      throw caught;
    }
  };
  const [requestError, setRequestError] = useState("");
  const [exporting, setExporting] = useState(false);
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
  const [leftTab, setLeftTab] = useState<"queue" | "clusters">("queue");
  const [queueView, setQueueView] = useState<"top" | "all" | "review">("all");
  const [activeCluster, setActiveCluster] = useState<number | null>(null);
  const [review, setReview] = useState<{ analysisId: string; gids: string[] }>({
    analysisId: "",
    gids: [],
  });
  const [searchNotice, setSearchNotice] = useState("");
  const clusterReturn = useRef<{
    selected: string;
    leftTab: "queue" | "clusters";
    scope: "ego" | "all";
    roleFilter: string;
    clusterFilter: string;
    depthFilter: string;
    seedOnly: boolean;
    colorBy: "role" | "cluster";
    query: string;
    queueView: "top" | "all" | "review";
    highlightMatches: boolean;
    detailTab: "overview" | "priority" | "transactions" | "assistant";
  } | null>(null);
  const [scope, setScope] = useState<"ego" | "all">("all");
  const [highlightMatches, setHighlightMatches] = useState(false);
  const [hops, setHops] = useState(1);
  const [colorBy, setColorBy] = useState<"role" | "cluster">("role");
  const [days, setDays] = useState<[number, number]>([0, 0]);
  const [visible, setVisible] = useState(0);
  const [detailTab, setDetailTab] = useState<
    "overview" | "priority" | "transactions" | "assistant"
  >("priority");
  const [exportOpen, setExportOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [edge, setEdge] = useState<GraphEdge | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [rowLimit, setRowLimit] = useState(50);
  const graph = useRef<GraphHandle>(null);
  const helpDialog = useRef<HTMLDialogElement>(null);
  const dossierScroll = useRef<HTMLDivElement>(null);
  const queueList = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dossierScroll.current?.scrollTo(0, 0);
  }, [selected, detailTab, activeCluster]);

  useEffect(() => {
    setRowLimit(50);
    queueList.current?.scrollTo(0, 0);
  }, [
    roleFilter,
    clusterFilter,
    depthFilter,
    seedOnly,
    query,
    leftTab,
    queueView,
  ]);

  useEffect(() => {
    if (help) helpDialog.current?.showModal();
    else helpDialog.current?.close();
  }, [help]);
  useEffect(() => {
    const clearKey = () => {
      setApiKey("");
      setKeyDialogOpen(false);
    };
    window.addEventListener("pagehide", clearKey);
    return () => window.removeEventListener("pagehide", clearKey);
  }, []);
  const pendingEdge = useRef<GraphEdge | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    requestDataset("/api/analysis", { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw Error("Не удалось загрузить анализ");
        return r.json();
      })
      .then((data: Analysis) => {
        setAnalysis(data);
        setDays([
          calendarDay(data.summary.period_start),
          calendarDay(data.summary.period_end),
        ]);
        setSelected(
          [...data.nodes].sort((a, b) => a.rank - b.rank)[0]?.gid || "",
        );
        setReview((current) =>
          current.analysisId === data.analysis_id
            ? current
            : { analysisId: data.analysis_id, gids: [] },
        );
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
    setEdge(pendingEdge.current);
    pendingEdge.current = null;
    setCopied(false);
    requestDataset(`/api/nodes/${encodeURIComponent(selected)}`, {
      signal: abort.signal,
    })
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
  const orderedNodes = useMemo(
    () => [...(analysis?.nodes || [])].sort((a, b) => a.rank - b.rank),
    [analysis],
  );
  const reviewNodes =
    review.analysisId === analysis?.analysis_id
      ? review.gids
          .map((gid) => analysis.nodes.find((n) => n.gid === gid))
          .filter((n): n is GraphNode => Boolean(n))
      : [];
  const exactMatch = analysis?.nodes.find((n) => n.gid === query.trim());
  const queue = useMemo(() => {
    const search = query.trim();
    if (search) {
      const exact = orderedNodes.find((n) => n.gid === search);
      return exact
        ? [exact]
        : orderedNodes.filter((n) => n.gid.includes(search));
    }
    return queueView === "top"
      ? orderedNodes.slice(0, 20)
      : orderedNodes.filter(
          (n) =>
            allowed.has(n.gid) &&
            (queueView !== "review" ||
              (review.analysisId === analysis?.analysis_id &&
                review.gids.includes(n.gid))),
        );
  }, [orderedNodes, allowed, query, queueView, review, analysis?.analysis_id]);
  const filteredClusters = useMemo(
    () =>
      (analysis?.clusters || [])
        .map((cluster) => ({
          ...cluster,
          members: orderedNodes.filter(
            (n) => n.cluster_id === cluster.cluster_id,
          ),
        }))
        .sort((a, b) => b.n_nodes - a.n_nodes || a.cluster_id - b.cluster_id),
    [analysis, orderedNodes],
  );
  const shownCluster = filteredClusters.find(
    (c) => c.cluster_id === activeCluster,
  );
  const graphAllowed = useMemo(
    () =>
      activeCluster === null
        ? leftTab === "queue" && (!query.trim() || highlightMatches)
          ? new Set(queue.map((n) => n.gid))
          : allowed
        : new Set(
            (analysis?.nodes || [])
              .filter((n) => n.cluster_id === activeCluster)
              .map((n) => n.gid),
          ),
    [activeCluster, allowed, analysis, leftTab, queue, query, highlightMatches],
  );
  const cluster = analysis?.clusters.find(
    (c) => c.cluster_id === chosen?.cluster_id,
  );
  const filteredTx = (dossier?.transactions || []).filter(
    (t) =>
      inDateRange(t.date, days) &&
      (!edge || (t.src === edge.src && t.dst === edge.dst)),
  );
  const selectedOutside =
    !highlightMatches && chosen && !graphAllowed.has(selected);
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
    setRowLimit(50);
  };
  const resetSelection = () => {
    clearFilters();
    setQueueView("all");
    setQuery("");
    setActiveCluster(null);
    setSearchNotice("");
  };
  const selectQueueView = (view: "all" | "review" | "top") => {
    setQueueView(view);
    setQuery("");
    setSearchNotice("");
    setActiveCluster(null);
    if (view === "top") clearFilters();
  };
  const choose = (gid: string, global = false) => {
    setSelected(gid);
    setActiveCluster(null);
    setEdge(null);
    setDetailTab("overview");
    if (global || activeCluster !== null) {
      clearFilters();
      setDirection("both");
      setHops(1);
    }
  };
  const searchClient = (gid: string) => {
    const outside = !allowed.has(gid);
    choose(gid, true);
    setQueueView("all");
    setScope(highlightMatches ? "all" : "ego");
    setLeftTab("queue");
    setSearchNotice(
      highlightMatches
        ? "Клиент найден во всём наборе и выделен на полной сети. Фильтры сброшены."
        : outside
          ? "Клиент найден во всём наборе. Фильтры сброшены, показано его окружение."
          : "Показано окружение клиента во всём наборе.",
    );
  };
  const openCluster = (id: number) => {
    if (activeCluster === null)
      clusterReturn.current = {
        selected,
        leftTab,
        scope,
        roleFilter,
        clusterFilter,
        depthFilter,
        seedOnly,
        colorBy,
        query,
        queueView,
        highlightMatches,
        detailTab,
      };
    clearFilters();
    setActiveCluster(id);
    setLeftTab("clusters");
    setScope("all");
    setColorBy("role");
    setQuery("");
    setSearchNotice("");
    setEdge(null);
    const member = orderedNodes.find((n) => n.cluster_id === id);
    if (member && chosen?.cluster_id !== id) setSelected(member.gid);
  };
  const closeCluster = () => {
    const prior = clusterReturn.current;
    setActiveCluster(null);
    if (prior) {
      setSelected(prior.selected);
      setLeftTab(prior.leftTab);
      setScope(prior.scope);
      setRoleFilter(prior.roleFilter);
      setClusterFilter(prior.clusterFilter);
      setDepthFilter(prior.depthFilter);
      setSeedOnly(prior.seedOnly);
      setColorBy(prior.colorBy);
      setQuery(prior.query);
      setQueueView(prior.queueView);
      setHighlightMatches(prior.highlightMatches);
      setDetailTab(
        prior.detailTab === "transactions" ? "overview" : prior.detailTab,
      );
    } else {
      setLeftTab("queue");
      setDetailTab("overview");
    }
  };
  const toggleReview = (gid: string) => {
    if (!analysis) return;
    setReview((current) => {
      const gids =
        current.analysisId === analysis.analysis_id ? current.gids : [];
      return {
        analysisId: analysis.analysis_id,
        gids: gids.includes(gid)
          ? gids.filter((id) => id !== gid)
          : [...gids, gid],
      };
    });
  };
  const onEdge = (e: GraphEdge) => {
    if (activeCluster !== null) {
      clearFilters();
      setScope(highlightMatches ? "all" : "ego");
      setDirection("both");
    }
    setActiveCluster(null);
    if (selected !== e.src && selected !== e.dst) {
      pendingEdge.current = e;
      setSelected(direction === "in" && scope === "ego" ? e.dst : e.src);
    } else setEdge(e);
    setDetailTab("transactions");
  };
  const exportFile = async (file: string) => {
    setExporting(true);
    setRequestError("");
    try {
      const response = await requestDataset(`/api/exports/${file}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = file;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportOpen(false);
    } catch (caught) {
      setRequestError(
        caught instanceof Error ? caught.message : "Не удалось выгрузить CSV.",
      );
    } finally {
      setExporting(false);
    }
  };
  const fullDays: [number, number] = analysis
    ? [
        calendarDay(analysis.summary.period_start),
        calendarDay(analysis.summary.period_end),
      ]
    : [0, 0];
  const bins = timelineBins(dossier?.daily || [], fullDays);
  const timelineMax = Math.max(
    1,
    ...bins.map((bin) => Math.max(bin.in_amount, bin.out_amount)),
  );
  const selectedPeriod = displayPeriod(isoDay(days[0]), isoDay(days[1]));
  if (!analysis)
    return (
      <div className="startup">
        <img
          className="startup-logo"
          src="/tyuin-logo.png"
          alt="Tyuin — рысь-сыщик"
          width="1793"
          height="877"
        />
        <h1>Скрытые финансовые связи становятся понятными</h1>
        {error ? (
          <>
            <p>{error}</p>
            <div className="startup-actions">
              <button className="primary" onClick={() => location.reload()}>
                Повторить
              </button>
              {datasetId && (
                <button className="secondary" onClick={onRestore}>
                  Вернуть исходный набор
                </button>
              )}
              <button className="secondary" onClick={onUpload}>
                Загрузить данные
              </button>
            </div>
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
      <div className="app-body">
        <header className="topbar">
          <a className="wordmark" href="/" aria-label="Tyuin — главная">
            <img src="/tyuin-logo.png" alt="Tyuin" width="1793" height="877" />
          </a>
          <span className="header-divider" />
          <span className="product-name">Скрытые финансовые связи</span>
          <span className="workspace-period">
            {displayPeriod(
              analysis.summary.period_start,
              analysis.summary.period_end,
            )}
          </span>
          <div className="header-right">
            <span className="local-status">
              <i />
              Локальный анализ
            </span>
            <button className="secondary upload-button" onClick={onUpload}>
              <FileUp size={16} /> Загрузить данные
            </button>
            <div className="header-tools">
              <button
                className={`assistant-key-control ${apiKey ? "connected" : ""}`}
                onClick={() => setKeyDialogOpen(true)}
                title={
                  apiKey
                    ? "OpenAI: ключ задан в этой вкладке. Управление ключом"
                    : "Подключить OpenAI"
                }
              >
                <KeyRound size={15} />
                <span>{apiKey ? "OpenAI · ключ задан" : "Подключить AI"}</span>
              </button>
              <button
                className="help-button"
                aria-label="Справка и данные"
                title="Справка и данные"
                onClick={() => setHelp(true)}
              >
                <CircleHelp size={18} />
                <span>Справка и данные</span>
              </button>
            </div>
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
                  <p className="export-scope">
                    Весь набор · полный период.
                    <br />
                    Фильтры и перечень проверки не меняют CSV.
                  </p>
                  {[
                    ["nodes_roles.csv", "Все узлы и роли"],
                    ["clusters.csv", "Сообщества"],
                    ["top_nodes.csv", "Топ-20 всего набора"],
                  ].map(([file, label]) => (
                    <button
                      key={file}
                      onClick={() => void exportFile(file)}
                      disabled={exporting}
                    >
                      <FileText size={17} />
                      <span>
                        {label}
                        <small>{file}</small>
                      </span>
                      <ArrowUpRight size={14} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>
        <main>
          {(expired || notice || requestError) && (
            <div className="dataset-notice" role="alert">
              <span>
                {expired
                  ? "Загруженный набор больше недоступен. Загрузите его снова или вернитесь к исходному набору."
                  : requestError || notice}
              </span>
              {expired && (
                <button onClick={onRestore}>Вернуть исходный набор</button>
              )}
            </div>
          )}
          <DatasetPassport
            analysis={analysis}
            onRestore={datasetId ? onRestore : undefined}
            onNetwork={() => {
              clearFilters();
              setActiveCluster(null);
              setScope("all");
              setLeftTab("clusters");
              setQuery("");
            }}
          />
          <section
            className="workspace-filters"
            aria-label="Фильтры всех клиентов и графа"
          >
            <span className="filter-label">
              <Filter size={16} />
              Фильтры
            </span>
            <label>
              Роль
              <select
                aria-label="Роль"
                value={roleFilter}
                onChange={(e) => {
                  setRoleFilter(e.target.value);
                  setActiveCluster(null);
                  setQueueView((current) =>
                    current === "top" ? "all" : current,
                  );
                  setLeftTab("queue");
                  setQuery("");
                }}
              >
                <option value="all">Все роли</option>
                {Object.entries(roles).map(([key, role]) => (
                  <option key={key} value={key}>
                    {role.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Сообщество
              <select
                aria-label="Сообщество"
                value={clusterFilter}
                onChange={(e) => {
                  setClusterFilter(e.target.value);
                  setActiveCluster(null);
                  setQueueView((current) =>
                    current === "top" ? "all" : current,
                  );
                  setLeftTab("queue");
                  setQuery("");
                }}
              >
                <option value="all">Все сообщества</option>
                {analysis.clusters.map((c) => (
                  <option key={c.cluster_id} value={c.cluster_id}>
                    Сообщество {String(c.cluster_id).padStart(2, "0")} ·{" "}
                    {c.n_nodes}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Глубина
              <select
                aria-label="Глубина"
                value={depthFilter}
                onChange={(e) => {
                  setDepthFilter(e.target.value);
                  setActiveCluster(null);
                  setQueueView((current) =>
                    current === "top" ? "all" : current,
                  );
                  setLeftTab("queue");
                  setQuery("");
                }}
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
            </label>
            <label className="seed-filter">
              <input
                type="checkbox"
                checked={seedOnly}
                onChange={(e) => {
                  setSeedOnly(e.target.checked);
                  setActiveCluster(null);
                  setQueueView((current) =>
                    current === "top" ? "all" : current,
                  );
                  setLeftTab("queue");
                  setQuery("");
                }}
              />
              Только seed
            </label>
            <label className="seed-filter graph-filter-mode">
              <input
                type="checkbox"
                checked={highlightMatches}
                onChange={(event) => {
                  setHighlightMatches(event.target.checked);
                  if (event.target.checked) setScope("all");
                }}
              />
              Подсвечивать на всей сети
            </label>
            <button
              className="reset-filters"
              disabled={
                !hasFilters &&
                queueView === "all" &&
                !query.trim() &&
                activeCluster === null
              }
              onClick={resetSelection}
            >
              Сбросить фильтры
            </button>
            <span className="filter-count" aria-live="polite">
              {number(graphAllowed.size)} из {number(analysis.summary.n_nodes)}{" "}
              клиентов
            </span>
          </section>
          <section className="investigation">
            <aside className="queue-panel">
              <div className="queue-tools">
                <label className="search-box">
                  <Search size={15} />
                  <input
                    aria-label="Поиск по gid"
                    placeholder="Найти gid во всём наборе"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setQueueView("all");
                      setSearchNotice("");
                      setLeftTab("queue");
                      setActiveCluster(null);
                      setRowLimit(50);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (exactMatch) searchClient(exactMatch.gid);
                        else if (queue.length === 1) searchClient(queue[0].gid);
                        else
                          setSearchNotice(
                            queue.length
                              ? "Выберите клиента из совпадений или введите полный gid."
                              : "Такого gid нет в предоставленном наборе.",
                          );
                      }
                    }}
                  />
                  {query && (
                    <button
                      title="Очистить поиск"
                      onClick={() => {
                        setQuery("");
                        setSearchNotice("");
                      }}
                    >
                      <X size={13} />
                    </button>
                  )}
                </label>
              </div>
              {searchNotice && (
                <p className="search-notice" role="status">
                  {searchNotice}
                </p>
              )}
              <div className="queue-tabs">
                <button
                  className={leftTab === "queue" ? "active" : ""}
                  onClick={() => {
                    if (activeCluster !== null) closeCluster();
                    setLeftTab("queue");
                  }}
                >
                  Клиенты
                </button>
                <button
                  className={leftTab === "clusters" ? "active" : ""}
                  onClick={() => {
                    setLeftTab("clusters");
                    setQuery("");
                  }}
                >
                  Группы
                </button>
              </div>
              {leftTab === "queue" && (
                <div className="queue-mode" aria-label="Список клиентов">
                  <button
                    className={queueView === "all" ? "active" : ""}
                    aria-pressed={queueView === "all"}
                    onClick={() => selectQueueView("all")}
                  >
                    Все клиенты
                  </button>
                  <button
                    className={queueView === "review" ? "active" : ""}
                    aria-pressed={queueView === "review"}
                    onClick={() => selectQueueView("review")}
                  >
                    На проверку <span>{reviewNodes.length}</span>
                  </button>
                  <button
                    className={queueView === "top" ? "active" : ""}
                    aria-pressed={queueView === "top"}
                    title="Топ-20 всего набора, как в CSV"
                    onClick={() => selectQueueView("top")}
                  >
                    Топ-20
                  </button>
                </div>
              )}
              <div className="list-caption">
                <span>
                  {leftTab === "queue"
                    ? `${number(queue.length)} клиентов`
                    : `${filteredClusters.length} групп · весь набор`}
                </span>
                <span>
                  {leftTab === "queue" ? "ПРИОРИТЕТ /100" : "КЛИЕНТОВ"}
                </span>
              </div>
              <div className="queue-list" ref={queueList}>
                {leftTab === "queue" ? (
                  <>
                    {queueView === "review" && !query.trim() && (
                      <ReviewTools
                        nodes={reviewNodes}
                        analysisId={analysis.analysis_id}
                        visibleCount={queue.length}
                      />
                    )}
                    {queueView === "top" && !query.trim() && (
                      <p className="list-scope-note">
                        Топ-20 всего набора · совпадает с CSV
                      </p>
                    )}
                    {queue.slice(0, rowLimit).map((n) => (
                      <ClientRow
                        key={n.gid}
                        node={n}
                        selected={n.gid === selected}
                        inReview={reviewNodes.some(
                          (item) => item.gid === n.gid,
                        )}
                        expanded={queueView === "review" && !query.trim()}
                        onSelect={() => {
                          if (query.trim()) searchClient(n.gid);
                          else {
                            choose(n.gid, queueView === "top");
                            setDetailTab("priority");
                          }
                        }}
                        onToggleReview={() => toggleReview(n.gid)}
                      />
                    ))}
                    {queue.length === 0 &&
                      !(
                        queueView === "review" &&
                        reviewNodes.length === 0 &&
                        !query.trim()
                      ) && (
                        <div className="empty-list">
                          {query.trim()
                            ? "Такого gid нет в предоставленном наборе. Поиск охватывает всех клиентов."
                            : "По текущим фильтрам клиентов нет."}
                          <br />
                          <button
                            onClick={() =>
                              query.trim() ? setQuery("") : clearFilters()
                            }
                          >
                            {query.trim()
                              ? "Очистить поиск"
                              : "Сбросить фильтры"}
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
                  filteredClusters.map((c) => (
                    <button
                      className={`cluster-item ${c.cluster_id === activeCluster ? "selected" : ""}`}
                      key={c.cluster_id}
                      onClick={() => openCluster(c.cluster_id)}
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
                          Всего: {c.n_seed} seed · {amount(c.sum_kzt_internal)}{" "}
                          ₸
                        </small>
                      </div>
                      <span title={`Всего в сообществе: ${c.n_nodes}`}>
                        {c.members.length}
                        {c.members.length !== c.n_nodes && (
                          <small>из {c.n_nodes}</small>
                        )}
                      </span>
                    </button>
                  ))
                )}
                {leftTab === "clusters" && filteredClusters.length === 0 && (
                  <div className="empty-list">
                    Сообществ по этим фильтрам нет.
                    <br />
                    <button onClick={resetSelection}>Сбросить фильтры</button>
                  </div>
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
                  <h2>
                    {highlightMatches
                      ? "Вся сеть · подсветка"
                      : activeCluster !== null
                        ? `Сообщество ${String(activeCluster).padStart(2, "0")}`
                        : scope === "ego"
                          ? "Окружение клиента"
                          : graphAllowed.size !== analysis.nodes.length
                            ? "Сеть по фильтрам"
                            : "Вся сеть"}
                  </h2>
                  <span>
                    {number(visible)} из {number(analysis.summary.n_nodes)}{" "}
                    узлов
                    {highlightMatches &&
                      ` · подсвечено ${number(graphAllowed.size)}`}
                  </span>
                </div>
                <div className="segmented">
                  <button
                    className={scope === "ego" ? "active" : ""}
                    onClick={() => {
                      setActiveCluster(null);
                      setScope("ego");
                      setHighlightMatches(false);
                    }}
                  >
                    Окружение
                  </button>
                  <button
                    className={scope === "all" ? "active" : ""}
                    onClick={() => {
                      setActiveCluster(null);
                      setScope("all");
                    }}
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
                    <option value="both">Все направления</option>
                    <option value="in">Входящие цепочки</option>
                    <option value="out">Исходящие цепочки</option>
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
                  selectedEdgeId={edge?.id}
                  onSelect={(gid) => choose(gid)}
                  onEdge={onEdge}
                  scope={scope}
                  direction={direction}
                  hops={hops}
                  allowed={graphAllowed}
                  highlightMatches={highlightMatches}
                  colorBy={colorBy}
                  days={days}
                  onCount={setVisible}
                />
                <div className="canvas-top-note">
                  <span className="live-dot" />
                  {highlightMatches
                    ? "ПОДСВЕЧЕНЫ СОВПАДЕНИЯ"
                    : scope === "ego" && direction !== "both"
                      ? direction === "in"
                        ? "ВХОДЯЩИЕ МАРШРУТЫ"
                        : "ИСХОДЯЩИЕ МАРШРУТЫ"
                      : "НАБЛЮДАЕМЫЕ СВЯЗИ"}
                  {scope === "ego" && (
                    <span>
                      {" "}
                      · до {hops} {hops === 1 ? "перехода" : "переходов"}
                    </span>
                  )}
                </div>
                {!highlightMatches &&
                  graphAllowed.size === 0 &&
                  scope === "all" && (
                    <div className="canvas-empty">
                      <Filter size={25} />
                      <strong>Нет клиентов в выборке</strong>
                      <span>
                        Измените фильтры или включите подсветку, чтобы увидеть
                        всю сеть.
                      </span>
                    </div>
                  )}
                {chosen?.isolated && scope === "ego" && !selectedOutside && (
                  <div className="canvas-empty">
                    <GitBranch size={26} />
                    <strong>Узел без наблюдаемых связей</strong>
                    <span>
                      Клиент есть в seed. Переводы в выгрузке отсутствуют.
                    </span>
                  </div>
                )}
                {selectedOutside && scope === "ego" && (
                  <div className="canvas-empty">
                    <Filter size={25} />
                    <strong>Выбранный клиент вне фильтра</strong>
                    <button onClick={() => setScope("all")}>
                      Показать выборку на графе
                    </button>
                    <button onClick={resetSelection}>Сбросить фильтры</button>
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
                  {highlightMatches && (
                    <span>
                      <i className="match-dot" />
                      Ореол — совпадение с фильтрами
                    </span>
                  )}
                  {highlightMatches && (
                    <span>Тёмный контур — выбранный клиент</span>
                  )}
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
                    Операции клиента
                  </span>
                  <strong>{selectedPeriod}</strong>
                  <button
                    onClick={() => setDays(fullDays)}
                    disabled={
                      days[0] === fullDays[0] && days[1] === fullDays[1]
                    }
                  >
                    Сбросить
                  </button>
                </div>
                <div
                  className={bins.length > 40 ? "bars compact-bars" : "bars"}
                >
                  {bins.map((bin) => {
                    const label = displayPeriod(
                      isoDay(bin.start),
                      isoDay(bin.end),
                    );
                    return (
                      <button
                        key={bin.start}
                        type="button"
                        className={
                          bin.end < days[0] || bin.start > days[1]
                            ? "day-bar muted"
                            : "day-bar"
                        }
                        title={`${label} · вход ${fullAmount(bin.in_amount)} · выход ${fullAmount(bin.out_amount)}`}
                        aria-label={`${label}: вход ${fullAmount(bin.in_amount)}, выход ${fullAmount(bin.out_amount)}`}
                        onClick={() => setDays([bin.start, bin.end])}
                      >
                        <i
                          style={{
                            height: `${(bin.in_amount / timelineMax) * 100}%`,
                          }}
                        />
                        <b
                          style={{
                            height: `${(bin.out_amount / timelineMax) * 100}%`,
                          }}
                        />
                      </button>
                    );
                  })}
                </div>
                <div className="range-inputs">
                  <input
                    aria-label="Начало периода"
                    aria-valuetext={date(isoDay(days[0]))}
                    type="range"
                    min={fullDays[0]}
                    max={fullDays[1]}
                    disabled={fullDays[0] === fullDays[1]}
                    value={days[0]}
                    onChange={(event) =>
                      setDays([
                        +event.target.value,
                        Math.max(+event.target.value, days[1]),
                      ])
                    }
                  />
                  <input
                    aria-label="Конец периода"
                    aria-valuetext={date(isoDay(days[1]))}
                    type="range"
                    min={fullDays[0]}
                    max={fullDays[1]}
                    disabled={fullDays[0] === fullDays[1]}
                    value={days[1]}
                    onChange={(event) =>
                      setDays([
                        Math.min(days[0], +event.target.value),
                        +event.target.value,
                      ])
                    }
                  />
                </div>
                <div className="timeline-foot">
                  <span>{date(analysis.summary.period_start)}</span>
                  <span>
                    <i className="in-dot" /> Вход
                    <i className="out-dot" /> Выход
                  </span>
                  <span>{date(analysis.summary.period_end)}</span>
                </div>
              </div>
              <p className="period-scope">
                Даты меняют показ операций и яркость связей. Роли, приоритеты,
                суммы и CSV — за весь период набора.
              </p>
            </section>
            <aside className="dossier-panel">
              {shownCluster ? (
                <ClusterCard
                  cluster={shownCluster}
                  members={shownCluster.members}
                  onSelect={(gid) => choose(gid, true)}
                  onBack={closeCluster}
                />
              ) : (
                chosen && (
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
                              .then(() => setCopied(true))
                              .catch(() =>
                                setSearchNotice(
                                  "Не удалось скопировать. Выделите полный gid в досье.",
                                ),
                              );
                          }}
                        >
                          {copied ? <Check size={16} /> : <Copy size={16} />}
                        </button>
                      </div>
                      {selectedOutside && (
                        <p className="outside-notice">
                          Этот клиент вне текущей выборки
                        </p>
                      )}
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
                      </div>
                      <button
                        className={`review-toggle ${reviewNodes.some((n) => n.gid === chosen.gid) ? "added" : ""}`}
                        onClick={() => toggleReview(chosen.gid)}
                      >
                        {reviewNodes.some((n) => n.gid === chosen.gid) ? (
                          <Check size={14} />
                        ) : (
                          <Plus size={14} />
                        )}
                        {reviewNodes.some((n) => n.gid === chosen.gid)
                          ? "В перечне · убрать"
                          : "Добавить на проверку"}
                      </button>
                    </div>
                    <div className="detail-tabs">
                      {(
                        [
                          ["priority", "Приоритет"],
                          ["overview", "Роль"],
                          ["transactions", "Операции"],
                          ["assistant", "Ассистент"],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          className={detailTab === key ? "active" : ""}
                          onClick={() => {
                            setDetailTab(key);
                            if (key === "assistant" && !apiKey)
                              setKeyDialogOpen(true);
                            if (key !== "transactions") setEdge(null);
                          }}
                        >
                          {key === "assistant" && <Sparkles size={13} />}{" "}
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="dossier-scroll" ref={dossierScroll}>
                      {nodeError && (
                        <div className="error-box">{nodeError}</div>
                      )}
                      {detailTab === "priority" && (
                        <>
                          <PrioritySummary node={chosen} />
                          <div className="next-step">
                            <span className="section-label">СЛЕДУЮЩИЙ ШАГ</span>
                            <p>
                              <CornerDownRight size={16} />
                              {chosen.next_action}
                            </p>
                          </div>
                          <p className="micro-note">{chosen.limitations[0]}</p>
                          <button
                            className="dossier-action-link"
                            onClick={() => setDetailTab("overview")}
                          >
                            Гипотеза роли: {chosen.role_label}
                            <ChevronRight size={14} />
                          </button>
                          <button
                            className="dossier-action-link"
                            onClick={() => openCluster(chosen.cluster_id)}
                          >
                            Разобрать сообщество{" "}
                            {String(chosen.cluster_id).padStart(2, "0")}
                            <ChevronRight size={14} />
                          </button>
                        </>
                      )}
                      {detailTab === "overview" && (
                        <>
                          <RoleExplanation
                            node={
                              dossier?.node.gid === chosen.gid
                                ? dossier.node
                                : chosen
                            }
                          />
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
                            Совместимость по времени не доказывает движение
                            одних и тех же денег.
                          </p>
                          <button
                            className="community-link"
                            onClick={() => openCluster(chosen.cluster_id)}
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
                                {cluster?.n_nodes} узлов · {cluster?.n_seed}{" "}
                                seed
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
                            {selectedPeriod} · суммы из исходной выгрузки
                          </p>
                          {edge && (
                            <div className="edge-banner">
                              {shortId(edge.src)} → {shortId(edge.dst)}
                              <br />
                              {fullAmount(
                                filteredTx.reduce(
                                  (sum, t) => sum + t.amount,
                                  0,
                                ),
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
                              <div
                                key={t.ref + ":" + i}
                                className="transaction"
                              >
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
                                    {shortId(
                                      t.dst === selected ? t.src : t.dst,
                                    )}
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
                        <AssistantPanel
                          key={`${analysis.analysis_id}:${chosen.gid}`}
                          apiKey={apiKey}
                          node={
                            dossier?.node.gid === chosen.gid &&
                            dossier.analysis_id === analysis.analysis_id
                              ? dossier.node
                              : chosen
                          }
                          ready={
                            dossier?.node.gid === chosen.gid &&
                            dossier.analysis_id === analysis.analysis_id
                          }
                          period={{
                            start: analysis.summary.period_start,
                            end: analysis.summary.period_end,
                          }}
                          onConnect={() => setKeyDialogOpen(true)}
                          onRemove={() => setApiKey("")}
                          onFacts={() => setDetailTab("overview")}
                        />
                      )}
                    </div>
                    <div className="dossier-footer">
                      <ShieldCheck size={13} />
                      <span>Структурная гипотеза · не оценка виновности</span>
                    </div>
                  </>
                )
              )}
            </aside>
          </section>
          <footer className="page-footer">
            <div className="page-footer-meta">
              <span>
                <i />
                Расчёт метрик: {analysis.elapsed_seconds.toFixed(2)} с
              </span>
              <span className="page-footer-credit">
                Решение команды uniqore.ai на хакатоне hackalem.ai
              </span>
              <span>
                Анализ <code>{analysis.analysis_id.slice(0, 8)}</code> · v
                {analysis.algorithm_version}
              </span>
            </div>
          </footer>
        </main>
      </div>
      <AssistantKeyDialog
        open={keyDialogOpen}
        connected={Boolean(apiKey)}
        onClose={() => setKeyDialogOpen(false)}
        onConnect={setApiKey}
        onRemove={() => setApiKey("")}
      />
      <dialog
        ref={helpDialog}
        className="modal-backdrop"
        aria-labelledby="help-title"
        onCancel={() => setHelp(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setHelp(false);
        }}
      >
        <section className="method-modal" onClick={(e) => e.stopPropagation()}>
          <button
            className="modal-close icon-button"
            title="Закрыть"
            onClick={() => setHelp(false)}
          >
            <X size={20} />
          </button>
          <div className="eyebrow">ПРОЗРАЧНАЯ АНАЛИТИКА</div>
          <h2 id="help-title">Справка и данные</h2>
          <p>
            Наблюдаемая сеть переводов за{" "}
            {displayPeriod(
              analysis.summary.period_start,
              analysis.summary.period_end,
            )}
            .
          </p>
          <dl className="dataset-summary">
            <div>
              <dt>Клиенты</dt>
              <dd>
                {number(analysis.summary.n_nodes)}
                <small>{number(analysis.summary.n_edges)} связей</small>
              </dd>
            </div>
            <div>
              <dt>Объём переводов</dt>
              <dd>
                {amount(analysis.summary.total_amount)} ₸
                <small>
                  {number(analysis.summary.n_transactions)} операций
                </small>
              </dd>
            </div>
            <div>
              <dt>Исходные клиенты</dt>
              <dd>
                {analysis.summary.n_seeds} seed<small>4 колена обхода</small>
              </dd>
            </div>
            <div>
              <dt>На границе наблюдения</dt>
              <dd>
                {analysis.summary.n_boundary}
                <small>
                  <button
                    onClick={() => {
                      clearFilters();
                      setDepthFilter("4");
                      setScope("all");
                      setLeftTab("queue");
                      setQuery("");
                      setHelp(false);
                    }}
                  >
                    Показать клиентов →
                  </button>
                </small>
              </dd>
            </div>
          </dl>
          <h3>Как читать результат</h3>
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
              Только загруженные операции за указанный период, суммы от 5 000 ₸.
              Полные балансы неизвестны.
            </li>
            <li>
              Роли рассчитаны правилами; эталонной разметки для оценки accuracy
              нет.
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
      </dialog>
    </div>
  );
}
