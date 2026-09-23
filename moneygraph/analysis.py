"""Deterministic, explainable analysis of a bounded transaction graph.

Amounts are counted in integer tiyn. Roles describe observed structure, not guilt.
No model, external service or hard-coded client list participates in the pipeline.
"""
from __future__ import annotations

import hashlib
import json
import math
import platform
import time
from collections import Counter, deque
from importlib.metadata import version
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd

from .clusters import CLUSTER_THRESHOLDS, explain_cluster

ALGORITHM_VERSION = "1.1.0"
ROLES = {
    "coordinator": "Координатор",
    "consolidator": "Консолидатор",
    "distributor": "Распределитель",
    "transit": "Транзит",
    "terminal": "Наблюдаемый получатель",
    "peripheral": "Периферия",
    "unknown": "Роль не установлена",
}
ROLE_COLUMNS = ["gid", "role", "role_score", "cluster_id", "priority_score", "evidence"]
CLUSTER_COLUMNS = ["cluster_id", "n_nodes", "n_seed", "sum_kzt_internal", "top_gids", "hypothesis"]
TOP_COLUMNS = ["rank", "gid", "role", "priority_score", "why"]
OUTPUTS = ["nodes_roles.csv", "clusters.csv", "top_nodes.csv"]


class DataError(ValueError):
    pass


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def json_write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")


def as_cents(series: pd.Series) -> pd.Series:
    values = series.to_numpy(dtype=float)
    if not np.isfinite(values).all() or (values <= 0).any():
        raise DataError("Суммы переводов должны быть положительными конечными числами.")
    rounded = np.rint(values * 100)
    if (np.abs(values * 100 - rounded) > 0.001).any() or (rounded >= 2**63).any():
        raise DataError("Сумма не представима целым числом тиынов.")
    return pd.Series(rounded.astype(np.int64), index=series.index)


def validate_frames(nodes: pd.DataFrame, edges: pd.DataFrame, tx: pd.DataFrame):
    nodes, edges, tx = nodes.copy(), edges.copy(), tx.copy()
    for name, frame, columns in [
        ("nodes", nodes, ["gid", "depth", "is_seed"]),
        ("edges", edges, ["src", "dst", "sum_kzt", "n_tx", "depth"]),
        ("transactions", tx, ["src", "dst", "date", "sum_kzt"]),
    ]:
        missing = sorted(set(columns) - set(frame.columns))
        if missing:
            raise DataError(f"{name}: отсутствуют поля {', '.join(missing)}")
        if frame[columns].isna().any().any():
            raise DataError(f"{name}: обязательные поля содержат пустые значения.")
        for col in set(columns) & {"gid", "src", "dst", "depth", "n_tx"}:
            if not pd.api.types.is_integer_dtype(frame[col]):
                raise DataError(f"{name}.{col}: требуется целочисленный тип.")
    if nodes.empty or nodes.gid.duplicated().any():
        raise DataError("nodes: нужны непустой набор и уникальные gid.")
    if not pd.api.types.is_bool_dtype(nodes.is_seed):
        raise DataError("nodes.is_seed должен иметь тип bool.")
    if not nodes.depth.between(0, 4).all() or not edges.depth.between(1, 4).all():
        raise DataError("Глубина должна соответствовать обходу в четыре колена.")
    if not (nodes.is_seed == nodes.depth.eq(0)).all():
        raise DataError("Seed должны иметь depth=0, прочие узлы — depth>0.")
    if edges[["src", "dst"]].duplicated().any() or (edges.n_tx <= 0).any():
        raise DataError("edges: повторяющиеся пары или неположительное n_tx.")
    known = set(nodes.gid)
    if (set(edges.src) | set(edges.dst) | set(tx.src) | set(tx.dst)) - known:
        raise DataError("В переводах найдены gid, отсутствующие в nodes.")
    edges["cents"], tx["cents"] = as_cents(edges.sum_kzt), as_cents(tx.sum_kzt)
    try:
        tx["date"] = pd.to_datetime(tx.date, errors="raise")
    except (ValueError, TypeError) as exc:
        raise DataError("transactions.date: некорректная дата.") from exc
    if tx.empty or not tx.date.between("2026-07-01", "2026-07-31 23:59:59").all():
        raise DataError("Ожидаются транзакции за июль 2026 года.")
    if (tx.cents < 500_000).any():
        raise DataError("В выгрузке кейса переводы должны быть не меньше 5 000 KZT.")
    agg = tx.groupby(["src", "dst"], sort=True).agg(cents=("cents", "sum"), n_tx=("cents", "size"))
    comparison = edges.set_index(["src", "dst"])[["cents", "n_tx"]].sort_index()
    if not agg.index.equals(comparison.index):
        raise DataError("Пары edges и transactions не совпадают.")
    if not np.array_equal(agg.to_numpy(), comparison.to_numpy()):
        raise DataError("Суммы или количества transactions не совпадают с edges.")
    return (nodes.sort_values("gid").reset_index(drop=True),
            edges.sort_values(["src", "dst"]).reset_index(drop=True),
            tx.sort_values(["date", "src", "dst", "cents"], kind="stable").reset_index(drop=True))


def temporal_match(incoming: list[tuple[int, int]], outgoing: list[tuple[int, int]]) -> int:
    """FIFO-compatible volume at lags 1–2 days; no unit can be matched twice.

    Dates are ordinal integers, amounts are tiyn. Same-day order is unknown.
    This is a local compatibility measure, not attribution of individual money.
    """
    ins = sorted(incoming)
    pending: deque[list[int]] = deque()
    cursor, matched = 0, 0
    for day, amount in sorted(outgoing):
        while cursor < len(ins) and ins[cursor][0] < day:
            pending.append(list(ins[cursor]))
            cursor += 1
        while pending and pending[0][0] < day - 2:
            pending.popleft()
        remaining = amount
        while remaining and pending:
            use = min(remaining, pending[0][1])
            matched += use
            remaining -= use
            pending[0][1] -= use
            if not pending[0][1]:
                pending.popleft()
    return matched


def quantiles(values: pd.Series, active: pd.Series) -> pd.Series:
    out = pd.Series(0.0, index=values.index)
    out.loc[active] = values.loc[active].rank(method="average", pct=True)
    out.loc[values.eq(0)] = 0.0
    return out


def money(value: float) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f} млн ₸"
    return f"{value:,.0f} ₸".replace(",", " ")


def explain_role(row: pd.Series, role: str, support: float, threshold_in: int,
                 threshold_out: int, threshold_b: float, limitations: list[str]) -> dict:
    """Describe the actual ordered rule and its heuristic score, not accuracy.

    Raw observations and thresholds retain precision so callers can distinguish
    decisions at a threshold boundary.
    """
    def criterion(key, label, observed, operator, threshold):
        passed = False
        if observed is not None and threshold is not None:
            if operator == "gte":
                passed = observed >= threshold
            elif operator == "eq":
                passed = observed == threshold
            elif operator == "between":
                passed = threshold[0] <= observed <= threshold[1]
        return {"key": key, "label": label, "observed": observed, "operator": operator,
                "threshold": threshold, "passed": bool(passed)}

    inbound = criterion("in_degree", "Клиентов-отправителей", int(row.in_degree), "gte", 1)
    outbound = criterion("out_degree", "Клиентов-получателей", int(row.out_degree), "gte", 1)
    inside = criterion("boundary", "На границе наблюдения", bool(row.depth == 4), "eq", False)
    rules = {
        "coordinator": [inbound, outbound,
                        criterion("betweenness", "Посредничество в сети", float(row.betweenness), "gte",
                                  None if math.isinf(threshold_b) else threshold_b),
                        criterion("neighbor_clusters", "Сообществ у соседей", int(row.neighbor_clusters), "gte", 2),
                        criterion("seed_reach", "Достижим из исходных клиентов", int(row.seed_reach), "gte", 2)],
        "consolidator": [criterion("in_degree", "Клиентов-отправителей", int(row.in_degree), "gte", threshold_in),
                         criterion("boundary", "На границе: перевес входящих не проверяется", True, "eq", True)
                         if row.depth == 4 else
                         criterion("in_dominance", "Отправителей ≥ 2 × получателей", int(row.in_degree), "gte", 2 * int(row.out_degree))],
        "distributor": [criterion("out_degree", "Клиентов-получателей", int(row.out_degree), "gte", threshold_out),
                        criterion("is_seed", "Исходный клиент: перевес исходящих не проверяется", True, "eq", True)
                        if row.is_seed else
                        criterion("out_dominance", "Получателей ≥ 2 × отправителей", int(row.out_degree), "gte", 2 * int(row.in_degree))],
        "transit": [criterion("is_seed", "Исходный клиент", bool(row.is_seed), "eq", False), inside,
                    inbound, outbound,
                    criterion("ratio", "Отношение выхода к входу", None if pd.isna(row.ratio) else float(row.ratio), "between", [.8, 1.2])],
        "terminal": [inbound, criterion("out_degree", "Клиентов-получателей", int(row.out_degree), "eq", 0), inside],
    }
    excluded = []
    if row.degree == 0:
        criteria = [criterion("degree", "Наблюдаемых связей", 0, "eq", 0)]
        selection = "Нет наблюдаемых связей: данных для гипотезы недостаточно."
    else:
        for candidate, checks in rules.items():
            if candidate == role:
                break
            excluded.append({"role": candidate, "label": ROLES[candidate],
                             "unmet_criteria": [check for check in checks if not check["passed"]]})
        if role in rules:
            criteria = rules[role]
            selection = "Выбрано первое выполненное правило; правила более поздних ролей не сравниваются по баллам."
        else:
            criteria = [criterion("specialized_rule", "Есть выполненное правило другой роли", False, "eq", False),
                        criterion("boundary", "На границе наблюдения", bool(row.depth == 4), "eq", role == "unknown")]
            selection = ("На границе выгрузки данных для гипотезы недостаточно."
                         if role == "unknown" else "Ни одно из пяти правил выраженных ролей не выполнено.")

    score_fields = {
        "coordinator": [("q_betweenness", "Ранг посредничества", .5), ("q_seed_reach", "Ранг достижимости из исходных клиентов", .5)],
        "consolidator": [("q_in_degree", "Ранг числа отправителей", .5), ("q_in_tx", "Ранг входящих переводов", .5)],
        "distributor": [("q_out_degree", "Ранг числа получателей", .5), ("q_out_tx", "Ранг исходящих переводов", .5)],
        "transit": [("balance", "Меньший поток / больший поток", .6), ("temporal_fraction", "Совместимый объём с лагом 1–2 дня / больший поток", .4)],
        "terminal": [("q_in_cents", "Ранг входящей суммы", .5), ("q_in_tx", "Ранг входящих переводов", .5)],
        "peripheral": [("q_degree", "Ранг числа связей", None), ("q_flow", "Ранг объёма", None), ("q_betweenness", "Ранг посредничества", None)],
        "unknown": [],
    }
    cap = .5 if role == "consolidator" and row.depth == 4 else None
    formula = ("1 − максимум трёх рангов" if role == "peripheral" else
               "0: данных для гипотезы недостаточно" if role == "unknown" else
               "Сумма факторов с указанными весами")
    if cap is not None:
        formula += "; на границе выгрузки результат ограничен 50/100"
    return {
        "status": "insufficient_data" if role == "unknown" else "hypothesis",
        "criteria": criteria,
        "selection": selection,
        "rule_order": list(rules),
        "excluded_rules": excluded,
        "threshold_method": ("Порог отправителей: максимум из 3 и округлённого вверх 75-го перцентиля положительных входящих степеней; "
                             "получателей: максимум из 10 и такого же перцентиля исходящих степеней; "
                             "посредничества: 90-й перцентиль положительных значений. Если положительных значений нет, правило координатора недоступно."),
        "score": {
            "kind": "heuristic_support", "value": round(float(support), 6), "formula": formula, "cap": cap,
            "factors": [{"key": key, "label": label, "value": float(row[key]), "weight": weight}
                        for key, label, weight in score_fields[role]],
            "rank_method": "Ранги рассчитаны среди клиентов с наблюдаемыми связями; совпадения получают средний ранг, нулевые значения — 0.",
            "interpretation": "Поддержка признаками по правилам, не вероятность и не точность. На размеченных данных точность не измерялась; баллы разных ролей не сравниваются.",
        },
        "limitations": limitations,
    }


def analyze(nodes: pd.DataFrame, edges: pd.DataFrame, tx: pd.DataFrame, input_hashes: dict | None = None) -> dict:
    started = time.perf_counter()
    nodes, edges, tx = validate_frames(nodes, edges, tx)
    G = nx.DiGraph()
    G.add_nodes_from(int(gid) for gid in nodes.gid)
    for row in edges.itertuples():
        G.add_edge(int(row.src), int(row.dst), cents=int(row.cents), n_tx=int(row.n_tx))
    df = nodes.set_index("gid").copy()
    for col, values in {
        "in_degree": dict(G.in_degree()), "out_degree": dict(G.out_degree()),
        "in_cents": dict(G.in_degree(weight="cents")), "out_cents": dict(G.out_degree(weight="cents")),
        "in_tx": dict(G.in_degree(weight="n_tx")), "out_tx": dict(G.out_degree(weight="n_tx")),
    }.items():
        df[col] = pd.Series(values).reindex(df.index).fillna(0).astype("int64")
    df["degree"] = df.in_degree + df.out_degree
    df["flow"] = df[["in_cents", "out_cents"]].max(axis=1)
    df["n_tx"] = df.in_tx + df.out_tx
    active = df.degree.gt(0)
    df["pagerank"] = pd.Series(nx.pagerank(G, weight="cents", max_iter=500, tol=1e-10))
    df["betweenness"] = pd.Series(nx.betweenness_centrality(G, weight=None, normalized=True))
    df["seed_reach"] = 0
    reaching: dict[int, list[int]] = {int(g): [] for g in df.index}
    for seed in nodes.loc[nodes.is_seed, "gid"]:
        for gid in nx.single_source_shortest_path_length(G, int(seed), cutoff=4):
            if gid != seed:
                reaching[gid].append(int(seed))
    df["seed_reach"] = [len(reaching[int(g)]) for g in df.index]

    UG = nx.Graph()
    UG.add_nodes_from(G.nodes)
    for source, target, attrs in G.edges(data=True):
        if source == target:
            continue
        prior = UG.get_edge_data(source, target, {}).get("weight", 0)
        UG.add_edge(source, target, weight=prior + attrs["cents"])
    connected = [g for g, degree in UG.degree() if degree]
    communities = nx.community.louvain_communities(UG.subgraph(connected), seed=42, resolution=1) if connected else []
    communities += [{g} for g in UG.nodes if UG.degree(g) == 0]
    communities.sort(key=min)
    membership = {gid: i + 1 for i, group in enumerate(communities) for gid in group}
    df["cluster_id"] = pd.Series(membership)
    df["neighbor_clusters"] = [len({membership[n] for n in set(G.predecessors(g)) | set(G.successors(g))}) for g in df.index]

    incoming: dict[int, list] = {g: [] for g in G.nodes}
    outgoing: dict[int, list] = {g: [] for g in G.nodes}
    for row in tx.itertuples():
        ordinal = row.date.toordinal()
        incoming[int(row.dst)].append((ordinal, int(row.cents)))
        outgoing[int(row.src)].append((ordinal, int(row.cents)))
    df["matched_cents"] = [temporal_match(incoming[g], outgoing[g]) for g in df.index]
    df["temporal_fraction"] = df.matched_cents.div(df.flow.replace(0, np.nan)).fillna(0)
    df["balance"] = df[["in_cents", "out_cents"]].min(axis=1).div(df.flow.replace(0, np.nan)).fillna(0)
    df["ratio"] = df.out_cents.div(df.in_cents.replace(0, np.nan))
    for col in ["in_degree", "out_degree", "in_tx", "out_tx", "in_cents", "flow", "degree", "n_tx", "betweenness", "seed_reach"]:
        df[f"q_{col}"] = quantiles(df[col], active)
    threshold_in = max(3, math.ceil(df.loc[df.in_degree.gt(0), "in_degree"].quantile(.75)))
    threshold_out = max(10, math.ceil(df.loc[df.out_degree.gt(0), "out_degree"].quantile(.75))) if df.out_degree.gt(0).any() else 10
    positive_b = df.loc[df.betweenness.gt(0), "betweenness"]
    threshold_b = float(positive_b.quantile(.90)) if len(positive_b) else math.inf
    df["priority_score"] = (.35 * df.q_flow + .25 * df.q_betweenness + .25 * df.q_seed_reach + .15 * df.q_n_tx).where(active, 0)

    node_rows = []
    for gid, row in df.iterrows():
        boundary = row.depth == 4
        isolated = row.degree == 0
        role, support = "peripheral", 1 - max(row.q_degree, row.q_flow, row.q_betweenness)
        if isolated:
            role, support = "unknown", 0
        elif row.in_degree and row.out_degree and row.betweenness >= threshold_b and row.neighbor_clusters >= 2 and row.seed_reach >= 2:
            role, support = "coordinator", (row.q_betweenness + row.q_seed_reach) / 2
        elif row.in_degree >= threshold_in and (boundary or row.in_degree >= 2 * row.out_degree):
            role, support = "consolidator", (row.q_in_degree + row.q_in_tx) / 2
            if boundary:
                support = min(support, .5)
        elif row.out_degree >= threshold_out and (row.is_seed or row.out_degree >= 2 * row.in_degree):
            role, support = "distributor", (row.q_out_degree + row.q_out_tx) / 2
        elif not row.is_seed and not boundary and row.in_degree and row.out_degree and .8 <= row.ratio <= 1.2:
            role, support = "transit", .6 * row.balance + .4 * row.temporal_fraction
        elif row.in_degree and not row.out_degree and not boundary:
            role, support = "terminal", (row.q_in_cents + row.q_in_tx) / 2
        elif boundary:
            role, support = "unknown", 0
        evidence = {
            "coordinator": f"Связь с {int(row.seed_reach)} seed; {int(row.neighbor_clusters)} сообществ у соседей; посредничество {row.betweenness:.4f}.",
            "consolidator": f"Получает от {int(row.in_degree)} клиентов: {money(row.in_cents / 100)}; исходящих контрагентов: {int(row.out_degree)}.",
            "distributor": f"Отправляет {int(row.out_degree)} клиентам: {money(row.out_cents / 100)}; переводов: {int(row.out_tx)}.",
            "transit": f"Выход/вход: {row.ratio:.2f}; {row.temporal_fraction:.0%} объёма совместимо с лагом 1–2 дня.",
            "terminal": f"Вход: {money(row.in_cents / 100)} от {int(row.in_degree)} клиентов; наблюдаемых исходящих: 0; глубина {int(row.depth)}.",
            "peripheral": f"Входящих связей: {int(row.in_degree)}; исходящих: {int(row.out_degree)}; выраженных признаков иных ролей нет.",
            "unknown": "Связей: 0. В выгрузке нет наблюдений для определения роли." if isolated else f"Глубина 4; вход {money(row.in_cents / 100)}; дальнейшие переводы за границей наблюдения.",
        }[role]
        if boundary and role == "consolidator":
            evidence += " Выход обрезан 4-м коленом; гипотеза частичная."
        limitations = ["Видны только внутрибанковские переводы от 5 000 ₸ за июль. Остатки и внешние потоки неизвестны."]
        if boundary:
            limitations.insert(0, "Граница выгрузки: дальнейшие исходящие переводы не наблюдаются.")
        if row.is_seed:
            limitations.insert(0, "Вход seed неполон. Отношение выхода к входу не является балансом счёта.")
        if isolated:
            limitations.insert(0, "Клиент есть в списке seed, но ни одного перевода в выборке нет.")
        next_action = ("Запросить исходящие переводы следующего колена для этого клиента." if boundary
                       else "Запросить входящие потоки клиента за пределами исходной выборки." if row.is_seed
                       else "Сверить основания гипотезы с полными операциями и назначениями переводов.")
        if isolated:
            next_action = "Уточнить полноту выгрузки и наличие операций клиента за выбранный период."
        nr = {
            "gid": str(gid), "role": role, "role_label": ROLES[role], "role_score": round(float(support), 6),
            "priority_score": round(float(row.priority_score), 6), "cluster_id": int(row.cluster_id),
            "depth": int(row.depth), "is_seed": bool(row.is_seed), "boundary": bool(boundary), "isolated": bool(isolated),
            "in_degree": int(row.in_degree), "out_degree": int(row.out_degree),
            "in_amount": int(row.in_cents) / 100, "out_amount": int(row.out_cents) / 100,
            "in_tx": int(row.in_tx), "out_tx": int(row.out_tx), "seed_reach": int(row.seed_reach),
            "pagerank": round(float(row.pagerank), 9), "betweenness": round(float(row.betweenness), 9),
            "ratio": None if pd.isna(row.ratio) else round(float(row.ratio), 4),
            "temporal_fraction": round(float(row.temporal_fraction), 6), "matched_amount": int(row.matched_cents) / 100,
            "evidence": evidence[:200], "limitations": limitations, "next_action": next_action,
            "role_explanation": explain_role(row, role, support, threshold_in, threshold_out, threshold_b, limitations),
            "observed_sink": bool(row.in_degree > 0 and row.out_degree == 0),
            "priority_factors": {"volume": round(.35 * row.q_flow, 6), "bridge": round(.25 * row.q_betweenness, 6),
                                 "seed_reach": round(.25 * row.q_seed_reach, 6), "activity": round(.15 * row.q_n_tx, 6)},
        }
        contributions = nr["priority_factors"]
        nr["why"] = (
            f"Объём {money(int(row.flow) / 100)}: +{contributions['volume'] * 100:.2f} балла; "
            f"посредничество на кратчайших маршрутах ({row.betweenness:.6g}): +{contributions['bridge'] * 100:.2f}; "
            f"достижимость от {int(row.seed_reach)} seed: +{contributions['seed_reach'] * 100:.2f}; "
            f"активность {int(row.n_tx)} участий в переводах: +{contributions['activity'] * 100:.2f}. "
            f"Итого {nr['priority_score'] * 100:.2f}/100; вклады округлены."
        )
        node_rows.append(nr)
    ordered = sorted(node_rows, key=lambda n: (-n["priority_score"], int(n["gid"])))
    for rank, nr in enumerate(ordered, 1):
        nr["rank"] = rank
    node_index = {n["gid"]: n for n in node_rows}
    cluster_rows = []
    for i, group in enumerate(communities, 1):
        members = sorted((node_index[str(g)] for g in group), key=lambda n: n["rank"])
        internal = sum(a["cents"] for s, d, a in G.edges(data=True) if membership[s] == i == membership[d])
        roles = Counter(n["role"] for n in members)
        n_seed = sum(n["is_seed"] for n in members)
        explanation = explain_cluster(G, group, node_index)
        hypothesis = " ".join([explanation["purpose"] + ".", *explanation["evidence"], *explanation["limitations"]])
        cluster_rows.append({"cluster_id": i, "n_nodes": len(group), "n_seed": n_seed,
                             "sum_kzt_internal": internal / 100, "top_gids": [n["gid"] for n in members[:5]],
                             "hypothesis": hypothesis, "roles": dict(roles), "explanation": explanation})
    edge_days = {}
    for (src, dst, day), group in tx.groupby(["src", "dst", "date"], sort=True):
        edge_days.setdefault((int(src), int(dst)), []).append({
            "date": day.date().isoformat(), "amount": int(group.cents.sum()) / 100, "n_tx": len(group)})
    edge_rows = []
    for row in edges.itertuples():
        edge_rows.append({"id": f"{row.src}:{row.dst}", "src": str(row.src), "dst": str(row.dst),
                          "amount": int(row.cents) / 100, "n_tx": int(row.n_tx), "depth": int(row.depth),
                          "daily": edge_days[(int(row.src), int(row.dst))]})
    # Dates remain calendar dates, never converted through the browser's timezone.
    transactions = []
    for row in tx.itertuples():
        transactions.append({"src": str(row.src), "dst": str(row.dst), "date": row.date.date().isoformat(),
                             "amount": int(row.cents) / 100, "ref": getattr(row, "ref", f"row:{row.Index}")})
    daily = [{"date": day.date().isoformat(), "amount": int(group.cents.sum()) / 100, "n_tx": len(group)}
             for day, group in tx.groupby("date", sort=True)]
    identity = {"algorithm": ALGORITHM_VERSION, "inputs": input_hashes or {}, "nodes": [n["gid"] for n in node_rows]}
    analysis_id = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:16]
    manifest = {
        "analysis_id": analysis_id, "algorithm_version": ALGORITHM_VERSION, "input_sha256": input_hashes or {},
        "parameters": {"louvain_seed": 42, "resolution": 1, "in_degree_threshold": threshold_in,
                       "out_degree_threshold": threshold_out, "coordinator_betweenness_threshold": None if math.isinf(threshold_b) else threshold_b,
                       "transit_ratio": [.8, 1.2], "temporal_lag_days": [1, 2], "priority_weights": [.35, .25, .25, .15],
                       "cluster_hypothesis_thresholds": dict(CLUSTER_THRESHOLDS)},
        "environment": {"python": platform.python_version(), "platform": platform.platform(),
                        "packages": {p: version(p) for p in ["pandas", "numpy", "networkx", "pyarrow"]}},
    }
    summary = {"n_nodes": len(nodes), "n_edges": len(edges), "n_transactions": len(tx),
               "n_seeds": int(nodes.is_seed.sum()), "n_isolated": int((~active).sum()),
               "n_boundary": int(nodes.depth.eq(4).sum()), "n_clusters": len(communities),
               "n_components": nx.number_weakly_connected_components(G),
               "total_amount": int(edges.cents.sum()) / 100, "period_start": "2026-07-01", "period_end": "2026-07-31",
               "roles": dict(Counter(n["role"] for n in node_rows)),
               "duplicate_records_preserved": int(tx[["src", "dst", "date", "cents"]].duplicated().sum())}
    result = {"analysis_id": analysis_id, "algorithm_version": ALGORITHM_VERSION, "summary": summary,
              "nodes": node_rows, "edges": edge_rows, "clusters": cluster_rows, "daily": daily,
              "transactions": transactions, "manifest": manifest}
    manifest["elapsed_seconds"] = round(time.perf_counter() - started, 4)
    return result


def load_and_analyze(data: Path) -> dict:
    started = time.perf_counter()
    paths = {name: data / f"{name}.parquet" for name in ["nodes", "edges", "transactions"]}
    for path in paths.values():
        if not path.is_file():
            raise DataError(f"Не найден входной файл: {path.name}")
    hashes = {p.name: sha256(p) for p in paths.values()}
    frames = {name: pd.read_parquet(path) for name, path in paths.items()}
    frames["transactions"]["ref"] = [f"{hashes['transactions.parquet'][:12]}:{i}" for i in range(len(frames["transactions"]))]
    result = analyze(frames["nodes"], frames["edges"], frames["transactions"], hashes)
    result["manifest"]["elapsed_seconds"] = round(time.perf_counter() - started, 4)
    return result


def write_outputs(result: dict, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    nodes = sorted(result["nodes"], key=lambda n: int(n["gid"]))
    pd.DataFrame(nodes)[ROLE_COLUMNS].to_csv(out / OUTPUTS[0], index=False, float_format="%.6f")
    clusters = [{**c, "top_gids": ";".join(c["top_gids"])} for c in result["clusters"]]
    pd.DataFrame(clusters, columns=CLUSTER_COLUMNS).to_csv(out / OUTPUTS[1], index=False, float_format="%.2f")
    top = sorted(nodes, key=lambda n: n["rank"])[:20]
    pd.DataFrame(top)[TOP_COLUMNS].to_csv(out / OUTPUTS[2], index=False, float_format="%.6f")
    result["manifest"]["output_sha256"] = {name: sha256(out / name) for name in OUTPUTS}
    json_write(out / "manifest.json", result["manifest"])
    json_write(out / "analysis.json", result)


def verify_outputs(data: Path, out: Path) -> dict:
    expected = pd.read_parquet(data / "nodes.parquet").gid.astype(str)
    roles = pd.read_csv(out / OUTPUTS[0], dtype={"gid": str})
    clusters = pd.read_csv(out / OUTPUTS[1], dtype={"top_gids": str})
    top = pd.read_csv(out / OUTPUTS[2], dtype={"gid": str})
    for frame, columns in [(roles, ROLE_COLUMNS), (clusters, CLUSTER_COLUMNS), (top, TOP_COLUMNS)]:
        if not set(columns).issubset(frame.columns) or frame[columns].isna().any().any():
            raise DataError("CSV: отсутствуют обязательные поля или значения.")
    if roles.gid.duplicated().any() or set(roles.gid) != set(expected) or len(roles) != len(expected):
        raise DataError("nodes_roles.csv не покрывает все gid ровно один раз.")
    if not roles.role.isin(ROLES).all() or not roles.evidence.str.len().between(1, 200).all():
        raise DataError("Недопустимая роль или длина evidence.")
    if not roles.evidence.str.contains(r"\d").all():
        raise DataError("Каждое evidence должно содержать числа.")
    for col in ["role_score", "priority_score"]:
        if not roles[col].between(0, 1).all():
            raise DataError(f"{col} должен быть в диапазоне 0–1.")
    if clusters.cluster_id.duplicated().any() or set(roles.cluster_id) != set(clusters.cluster_id):
        raise DataError("Кластеры не соответствуют узлам.")
    actual_sizes = roles.groupby("cluster_id").size()
    if not all(actual_sizes[int(c.cluster_id)] == c.n_nodes for c in clusters.itertuples()):
        raise DataError("Размеры кластеров не сходятся.")
    ordered = roles.assign(_gid=roles.gid.map(int)).sort_values(["priority_score", "_gid"], ascending=[False, True]).head(20)
    if len(top) < min(20, len(expected)) or top.gid.tolist() != ordered.gid.tolist():
        raise DataError("Top не соответствует приоритетам.")
    if top["rank"].tolist() != list(range(1, len(top) + 1)):
        raise DataError("Ранги top не последовательны.")
    aligned = roles.set_index("gid").loc[top.gid]
    if aligned.role.tolist() != top.role.tolist() or not np.allclose(aligned.priority_score, top.priority_score, atol=1e-7):
        raise DataError("Роли/приоритеты top расходятся с nodes_roles.")
    manifest = json.loads((out / "manifest.json").read_text())
    for name, digest in manifest["input_sha256"].items():
        if sha256(data / name) != digest:
            raise DataError("Входные файлы изменились после расчёта.")
    for name in OUTPUTS:
        if sha256(out / name) != manifest["output_sha256"][name]:
            raise DataError(f"{name}: контрольная сумма не соответствует manifest.")
    return {"status": "ok", "analysis_id": manifest["analysis_id"], "nodes": len(roles), "clusters": len(clusters), "top": len(top)}
