export type Role =
  | "coordinator"
  | "consolidator"
  | "distributor"
  | "transit"
  | "terminal"
  | "peripheral"
  | "unknown";
export interface GraphNode {
  gid: string;
  role: Role;
  role_label: string;
  role_score: number;
  priority_score: number;
  cluster_id: number;
  depth: number;
  is_seed: boolean;
  boundary: boolean;
  isolated: boolean;
  in_degree: number;
  out_degree: number;
  in_amount: number;
  out_amount: number;
  in_tx: number;
  out_tx: number;
  seed_reach: number;
  rank: number;
  pagerank: number;
  betweenness: number;
  ratio: number | null;
  temporal_fraction: number;
  matched_amount: number;
  evidence: string;
  limitations: string[];
  next_action: string;
  why: string;
  priority_factors: Record<string, number>;
}
export interface GraphEdge {
  id: string;
  src: string;
  dst: string;
  amount: number;
  n_tx: number;
  depth: number;
  daily: { date: string; amount: number; n_tx: number }[];
}
export interface Cluster {
  cluster_id: number;
  n_nodes: number;
  n_seed: number;
  sum_kzt_internal: number;
  top_gids: string[];
  hypothesis: string;
  roles: Record<string, number>;
}
export interface Transaction {
  src: string;
  dst: string;
  date: string;
  amount: number;
  ref: string;
}
export interface Analysis {
  analysis_id: string;
  algorithm_version: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: Cluster[];
  elapsed_seconds: number;
  assistant_available: boolean;
  summary: {
    n_nodes: number;
    n_edges: number;
    n_transactions: number;
    n_seeds: number;
    n_isolated: number;
    n_boundary: number;
    n_clusters: number;
    n_components: number;
    total_amount: number;
    period_start: string;
    period_end: string;
    roles: Record<string, number>;
  };
}
export interface Dossier {
  analysis_id: string;
  node: GraphNode;
  transactions: Transaction[];
  neighbors: GraphNode[];
  daily: {
    date: string;
    in_amount: number;
    out_amount: number;
    n_tx: number;
  }[];
}
export const roles: Record<
  Role,
  { label: string; color: string; tint: string }
> = {
  coordinator: { label: "Координатор", color: "#7865C8", tint: "#F1EDFC" },
  consolidator: { label: "Консолидатор", color: "#3876DB", tint: "#EAF1FE" },
  distributor: { label: "Распределитель", color: "#179C91", tint: "#E5F6F3" },
  transit: { label: "Транзит", color: "#68A5B6", tint: "#ECF5F8" },
  terminal: { label: "Получатель", color: "#C09353", tint: "#FAF2E6" },
  peripheral: { label: "Периферия", color: "#8A9AAC", tint: "#EEF1F5" },
  unknown: { label: "Не установлена", color: "#B1BAC6", tint: "#F1F3F5" },
};
export const number = (n: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n);
export const amount = (n: number) =>
  n >= 1e6
    ? `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n / 1e6)} млн`
    : n >= 1e3
      ? `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(n / 1e3)} тыс.`
      : number(n);
export const shortId = (gid: string) => `…${gid.slice(-7)}`;
