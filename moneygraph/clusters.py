"""Group hypotheses from observed directed motifs, independent of node roles.

The thresholds are explicit starting heuristics, not learned or calibrated.
Only edges between different members support motifs; self-transfers still count
in the exported internal turnover. A group hypothesis never implies ownership
or criminal purpose, and comparable monthly sums never trace individual funds.
"""
from __future__ import annotations

import networkx as nx


CLUSTER_THRESHOLDS = {
    "fan_degree_min": 3,
    "degree_dominance_min": 2,
    "fan_turnover_share_min": .25,
    "transit_balance_min": .8,
    "transit_turnover_share_min": .25,
}

CLUSTER_RULE = (
    "Сбор: у участника ≥3 внутренних отправителей, их число ≥2× числа внутренних получателей, "
    "вход составляет ≥25% внутреннего оборота. Распределение: зеркальное правило по выходу. "
    "Транзит: у участников не из seed и не на границе есть внутренние вход и выход, "
    "min(вход, выход)/max(вход, выход) ≥0,8; сумма min для этих участников составляет ≥25% "
    "внутреннего оборота. Сбор и распределение вместе → смешанная структура; иначе сбор, "
    "распределение, транзит или неопределённость, в этом порядке. Петли не поддерживают мотивы."
)


def _amount(cents: int) -> str:
    return f"{cents / 100:,.2f}".replace(",", " ").replace(".", ",") + " KZT"


def explain_cluster(graph: nx.DiGraph, group: set[int], node_index: dict[str, dict]) -> dict:
    """Explain a fixed community without changing its membership or any role."""
    facts = {gid: {"in_degree": 0, "out_degree": 0, "in_cents": 0, "out_cents": 0} for gid in group}
    internal = incoming = outgoing = self_transfers = internal_edges = 0
    for src, dst, attrs in graph.edges(data=True):
        cents = int(attrs["cents"])
        src_inside, dst_inside = src in group, dst in group
        if src_inside and dst_inside:
            internal += cents
            if src == dst:
                self_transfers += cents
                continue
            internal_edges += 1
            facts[src]["out_degree"] += 1
            facts[src]["out_cents"] += cents
            facts[dst]["in_degree"] += 1
            facts[dst]["in_cents"] += cents
        elif src_inside:
            outgoing += cents
        elif dst_inside:
            incoming += cents

    thresholds = CLUSTER_THRESHOLDS
    collectors, distributors, intermediates = [], [], []
    for gid, fact in facts.items():
        if not internal:
            continue
        for direction, opposite, selected in [("in", "out", collectors), ("out", "in", distributors)]:
            if (fact[f"{direction}_degree"] >= thresholds["fan_degree_min"]
                    and fact[f"{direction}_degree"] >= thresholds["degree_dominance_min"] * fact[f"{opposite}_degree"]
                    and fact[f"{direction}_cents"] / internal >= thresholds["fan_turnover_share_min"]):
                selected.append(gid)
        node = node_index[str(gid)]
        larger = max(fact["in_cents"], fact["out_cents"])
        if (not node["is_seed"] and not node["boundary"] and larger
                and min(fact["in_cents"], fact["out_cents"]) / larger >= thresholds["transit_balance_min"]):
            intermediates.append(gid)
    collectors.sort(key=lambda g: (-facts[g]["in_cents"], g))
    distributors.sort(key=lambda g: (-facts[g]["out_cents"], g))
    intermediates.sort(key=lambda g: (-min(facts[g]["in_cents"], facts[g]["out_cents"]), g))
    intermediate_cents = sum(min(facts[g]["in_cents"], facts[g]["out_cents"]) for g in intermediates)
    transit_share = intermediate_cents / internal if internal else 0
    transit = bool(intermediates and transit_share >= thresholds["transit_turnover_share_min"])
    kind = ("mixed" if collectors and distributors else "collection" if collectors else
            "distribution" if distributors else "transit" if transit else "undetermined")
    purposes = {
        "mixed": "Возможная смешанная структура: сбор и распределение средств",
        "collection": "Возможный сбор средств внутри группы",
        "distribution": "Возможное распределение средств внутри группы",
        "transit": "Возможное промежуточное прохождение средств внутри группы",
        "undetermined": "Назначение группы по наблюдаемым переводам не установлено",
    }
    evidence = []
    for candidates, direction, word in [(collectors, "in", "Сбор"), (distributors, "out", "Распределение")]:
        if candidates:
            gid = candidates[0]
            fact = facts[gid]
            evidence.append(
                f"{word}: клиент {gid}, внутренних отправителей {fact['in_degree']}, получателей {fact['out_degree']}; "
                f"{'вход' if direction == 'in' else 'выход'} {_amount(fact[f'{direction}_cents'])} "
                f"({fact[f'{direction}_cents'] / internal:.1%} внутреннего оборота). "
                f"Правило выполняют участников: {len(candidates)}."
            )
    if transit:
        evidence.append(
            f"Сопоставимые внутренние вход и выход у {len(intermediates)} участников; "
            f"сумма min(вход, выход) {_amount(intermediate_cents)}; "
            f"отношение этой суммы к внутреннему обороту {transit_share:.1%}. "
            f"Ключевой промежуточный клиент {intermediates[0]}."
        )
    if kind == "undetermined":
        if not graph.subgraph(group).number_of_edges() and not incoming and not outgoing:
            evidence.append("Наблюдаемых связей 0; без переводов определить функцию группы нельзя.")
        elif not internal_edges:
            evidence.append("Внутренних связей между разными участниками 0; структура группы не наблюдается.")
        else:
            evidence.append(
                f"Связей между разными участниками {internal_edges}; узлов сбора {len(collectors)}, "
                f"распределения {len(distributors)}. Отношение суммы min(вход, выход) подходящих участников "
                f"к внутреннему обороту {transit_share:.1%} "
                "не достигает порога 25%; имеющихся признаков недостаточно."
            )
    evidence.append(f"Через границу группы: вход {_amount(incoming)}, выход {_amount(outgoing)}; "
                    f"внутренний оборот {_amount(internal)}.")
    seed_count = sum(node_index[str(g)]["is_seed"] for g in group)
    boundary_count = sum(node_index[str(g)]["boundary"] for g in group)
    limitations = ["Группа выделена по связям, а не по общему владельцу; гипотеза не устанавливает виновность.",
                   "Видны только переводы внутри банка за июль от 5 000 KZT; внешние потоки и остатки неизвестны."]
    if seed_count:
        limitations.append(f"У {seed_count} исходных клиентов (seed) входящие потоки неполны; полный баланс группы неизвестен.")
    if boundary_count:
        limitations.append(f"На границе четвёртого колена {boundary_count} участников; отсутствие выхода не доказывает удержание средств.")
    if intermediates:
        limitations.append("Сходство месячных сумм не доказывает передачу тех же денег; одна последовательность переводов может учитываться у нескольких участников. Сумма min(вход, выход) не является объёмом уникальных средств.")
    if self_transfers:
        limitations.append(f"Переводы самому себе на {_amount(self_transfers)} включены в оборот, но не подтверждают связи разных участников.")
    explanation = {
        "kind": kind, "purpose": purposes[kind], "rule": CLUSTER_RULE,
        "evidence": evidence, "limitations": limitations,
        "incoming_amount": incoming / 100, "outgoing_amount": outgoing / 100,
        "metrics": {"internal_amount": internal / 100, "internal_edges": internal_edges,
                    "collection_nodes": len(collectors), "distribution_nodes": len(distributors),
                    "transit_nodes": len(intermediates), "transit_amount": intermediate_cents / 100,
                    "transit_share": transit_share, "seed_nodes": seed_count, "boundary_nodes": boundary_count,
                    "self_transfer_amount": self_transfers / 100},
        "thresholds": dict(thresholds),
    }
    return explanation
