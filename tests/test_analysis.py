import math
import json
import re
from collections import Counter
from decimal import Decimal

import pandas as pd
import pytest
import networkx as nx

from moneygraph.analysis import DataError, analyze, explain_role, temporal_match, validate_frames, verify_outputs
from moneygraph.clusters import explain_cluster
from conftest import DATA


def test_case_integrity_and_conservation(analysis, frames):
    nodes, edges, tx = frames
    calculated = analysis["nodes"]
    assert len(calculated) == 2248
    assert {n["gid"] for n in calculated} == set(nodes.gid.astype(str))
    assert all(isinstance(n["gid"], str) for n in calculated)
    assert analysis["summary"]["n_edges"] == 3119
    assert analysis["summary"]["n_transactions"] == 4840
    assert analysis["summary"]["duplicate_records_preserved"] == 97
    assert len(analysis["transactions"]) == len(tx)
    assert len({t["ref"] for t in analysis["transactions"]}) == len(tx)
    total = Decimal("365890012.01")
    assert sum(Decimal(str(n["out_amount"])) for n in calculated) == total
    assert sum(Decimal(str(n["in_amount"])) for n in calculated) == total
    assert sum(n["out_tx"] for n in calculated) == len(tx)
    assert sum(n["in_tx"] for n in calculated) == len(tx)
    for edge in analysis["edges"]:
        assert sum(d["n_tx"] for d in edge["daily"]) == edge["n_tx"]
        assert sum(Decimal(str(d["amount"])) for d in edge["daily"]) == Decimal(str(edge["amount"]))


def test_censored_nodes_seeds_isolates(analysis):
    nodes = analysis["nodes"]
    isolates = [n for n in nodes if n["isolated"]]
    boundary = [n for n in nodes if n["boundary"]]
    assert len(isolates) == 19 and all(n["is_seed"] for n in isolates)
    assert len({n["cluster_id"] for n in isolates}) == 19
    assert all(n["role"] == "unknown" and n["priority_score"] == 0 for n in isolates)
    assert len(boundary) == 444
    assert all(n["role"] not in {"terminal", "transit"} for n in boundary)
    assert all(n["role_score"] <= .5 for n in boundary)
    assert all(n["role"] != "transit" for n in nodes if n["is_seed"])
    assert any(n["priority_score"] > .5 for n in nodes if n["role"] == "unknown")


def test_role_explanation_matches_decisions_and_scores(analysis):
    """Each chosen rule passes; every earlier rule has an observed failure."""
    parameters = analysis["manifest"]["parameters"]
    for node in analysis["nodes"]:
        explanation = node["role_explanation"]
        assert all(c["passed"] for c in explanation["criteria"])
        assert all(rule["unmet_criteria"] for rule in explanation["excluded_rules"])
        assert all(not c["passed"] for rule in explanation["excluded_rules"] for c in rule["unmet_criteria"])
        assert explanation["limitations"] == node["limitations"]
        score = explanation["score"]
        assert score["kind"] == "heuristic_support"
        assert score["value"] == node["role_score"]
        assert "не вероятность и не точность" in score["interpretation"]
        factors = score["factors"]
        if node["role"] == "unknown":
            assert explanation["status"] == "insufficient_data"
            assert not factors and score["value"] == 0
        else:
            assert explanation["status"] == "hypothesis"
            expected = (1 - max(f["value"] for f in factors) if node["role"] == "peripheral"
                        else sum(f["value"] * f["weight"] for f in factors))
            if score["cap"] is not None:
                expected = min(expected, score["cap"])
            assert score["value"] == pytest.approx(expected, abs=5.1e-7)
        for criterion in explanation["criteria"]:
            if criterion["key"] in node:
                assert criterion["observed"] == pytest.approx(node[criterion["key"]], abs=5.1e-5)
        criteria = {c["key"]: c for c in explanation["criteria"]}
        if node["role"] == "coordinator":
            assert criteria["betweenness"]["threshold"] == parameters["coordinator_betweenness_threshold"]
            assert criteria["seed_reach"]["threshold"] == 2
            assert criteria["neighbor_clusters"]["threshold"] == 2
        elif node["role"] == "consolidator":
            assert criteria["in_degree"]["threshold"] == parameters["in_degree_threshold"]
        elif node["role"] == "distributor":
            assert criteria["out_degree"]["threshold"] == parameters["out_degree_threshold"]
        elif node["role"] == "transit":
            assert criteria["ratio"]["threshold"] == parameters["transit_ratio"]
        if node["role"] in explanation["rule_order"]:
            index = explanation["rule_order"].index(node["role"])
            assert [r["role"] for r in explanation["excluded_rules"]] == explanation["rule_order"][:index]
    # The API serializer must not encounter Infinity/NaN in observations or thresholds.
    json.dumps([n["role_explanation"] for n in analysis["nodes"]], allow_nan=False)


def test_role_explanation_censoring_and_fallback(analysis):
    for node in analysis["nodes"]:
        explanation = node["role_explanation"]
        criteria = {c["key"]: c for c in explanation["criteria"]}
        if node["isolated"]:
            assert list(criteria) == ["degree"] and criteria["degree"]["observed"] == 0
            assert not explanation["excluded_rules"]
        if node["role"] == "consolidator" and node["boundary"]:
            assert explanation["score"]["cap"] == .5
            assert criteria["boundary"]["observed"] is True
            assert "in_dominance" not in criteria
        if node["role"] == "distributor" and node["is_seed"]:
            assert criteria["is_seed"]["observed"] is True
            assert "out_dominance" not in criteria
        if node["role"] == "peripheral" or (node["role"] == "unknown" and not node["isolated"]):
            assert len(explanation["excluded_rules"]) == 5
            assert criteria["boundary"]["threshold"] == (node["role"] == "unknown")


def test_role_explanation_preserves_threshold_precision_and_unavailable_threshold():
    row = pd.Series({"in_degree": 1, "out_degree": 1, "degree": 2, "depth": 0,
                     "is_seed": True, "betweenness": .000000123456788, "neighbor_clusters": 2,
                     "seed_reach": 2, "ratio": 1.0, "q_degree": .2, "q_flow": .3,
                     "q_betweenness": .4, "q_seed_reach": .7})
    threshold = .000000123456789
    explanation = explain_role(row, "peripheral", .6, 3, 10, threshold, [])
    failure = next(c for c in explanation["excluded_rules"][0]["unmet_criteria"] if c["key"] == "betweenness")
    assert failure["observed"] == row.betweenness
    assert failure["threshold"] == threshold
    assert failure["passed"] is False
    # No positive betweenness in a graph makes the coordinator threshold unavailable.
    explanation = explain_role(row, "peripheral", .6, 3, 10, math.inf, [])
    failure = next(c for c in explanation["excluded_rules"][0]["unmet_criteria"] if c["key"] == "betweenness")
    assert failure["threshold"] is None and not failure["passed"]
    json.dumps(explanation, allow_nan=False)
    explanation = explain_role(row, "coordinator", .55, 3, 10, row.betweenness, [])
    assert all(c["passed"] for c in explanation["criteria"])
    assert not explanation["excluded_rules"]


@pytest.mark.parametrize("incoming,outgoing,expected", [
    ([(1, 100)], [(1, 100)], 0),  # No intraday order is known.
    ([(1, 100)], [(2, 80), (3, 80)], 100),  # No reuse of inbound volume.
    ([(1, 100)], [(4, 100)], 0),  # Expired window.
    ([(1, 70), (2, 50)], [(2, 50), (3, 80)], 120),
    ([(3, 100)], [(1, 100)], 0),  # No matching backwards in time.
    ([], [(1, 100)], 0),
])
def test_temporal_volume(incoming, outgoing, expected):
    assert temporal_match(incoming, outgoing) == expected


def test_cluster_totals_and_priority(analysis):
    nodes = {n["gid"]: n for n in analysis["nodes"]}
    for c in analysis["clusters"]:
        members = [n for n in nodes.values() if n["cluster_id"] == c["cluster_id"]]
        assert c["n_nodes"] == len(members)
        assert c["n_seed"] == sum(n["is_seed"] for n in members)
        assert set(c["top_gids"]).issubset(n["gid"] for n in members)
        internal = sum(Decimal(str(e["amount"])) for e in analysis["edges"]
                       if nodes[e["src"]]["cluster_id"] == nodes[e["dst"]]["cluster_id"] == c["cluster_id"])
        assert internal == Decimal(str(c["sum_kzt_internal"]))
    for n in nodes.values():
        assert 0 <= n["role_score"] <= 1 and 0 <= n["priority_score"] <= 1
        assert len(n["evidence"]) <= 200 and any(ch.isdigit() for ch in n["evidence"])
        assert math.isclose(sum(n["priority_factors"].values()), n["priority_score"], abs_tol=2.6e-6)
        assert n["matched_amount"] <= min(n["in_amount"], n["out_amount"]) + .001


def test_permutation_does_not_change_analysis(analysis, frames):
    shuffled = [f.sample(frac=1, random_state=73).reset_index(drop=True) for f in frames]
    rerun = analyze(*shuffled)
    for key in ("nodes", "edges", "clusters", "daily", "summary"):
        assert rerun[key] == analysis[key]


@pytest.mark.parametrize("change", ["sum", "count", "unknown_gid", "duplicate_gid", "fractional_gid", "date", "nan", "negative"])
def test_invalid_input_fails_before_classification(frames, change):
    nodes, edges, tx = [f.copy() for f in frames]
    if change == "sum":
        edges.loc[0, "sum_kzt"] += .01
    elif change == "count":
        edges.loc[0, "n_tx"] += 1
    elif change == "unknown_gid":
        tx.loc[0, "src"] = -1
    elif change == "duplicate_gid":
        nodes.loc[0, "gid"] = nodes.loc[1, "gid"]
    elif change == "fractional_gid":
        nodes["gid"] = nodes.gid.astype(float)
    elif change == "date":
        tx.loc[0, "date"] = pd.Timestamp("2026-08-01")
    elif change == "nan":
        tx.loc[0, "sum_kzt"] = float("nan")
    elif change == "negative":
        tx.loc[0, "sum_kzt"] = -1
    with pytest.raises(DataError):
        validate_frames(nodes, edges, tx)


def test_csv_contract_and_tampering(analysis, outputs, tmp_path):
    assert verify_outputs(DATA, outputs) == {"status": "ok", "analysis_id": analysis["analysis_id"], "nodes": 2248, "clusters": 88, "top": 20}
    for file in outputs.iterdir():
        (tmp_path / file.name).write_bytes(file.read_bytes())
    with (tmp_path / "top_nodes.csv").open("a") as f:
        f.write("\n")
    with pytest.raises(DataError, match="контрольная сумма"):
        verify_outputs(DATA, tmp_path)


def test_priority_explains_every_actual_contribution(analysis, outputs):
    top = pd.read_csv(outputs / "top_nodes.csv", dtype={"gid": str})
    by_gid = {n["gid"]: n for n in analysis["nodes"]}
    for node in analysis["nodes"]:
        why = node["why"]
        assert all(label in why for label in ["Объём", "посредничество", "достижимость", "активность"])
        displayed = [float(value) for value in re.findall(r"\+(\d+\.\d+)", why)]
        expected = [100 * node["priority_factors"][key] for key in ["volume", "bridge", "seed_reach", "activity"]]
        assert len(displayed) == 4
        assert displayed == pytest.approx(expected, abs=.00501)
        assert sum(displayed) == pytest.approx(100 * node["priority_score"], abs=.0203)
        assert "вклады округлены" in why
    for row in top.itertuples():
        node = by_gid[row.gid]
        assert row.why == node["why"] and row.rank == node["rank"]
        assert row.priority_score == node["priority_score"]


def group_explanation(edges, *, members=None, seeds=(), boundary=(), isolated=()):
    """Fixed hand-built groups test purpose rules independently of Louvain."""
    graph = nx.DiGraph()
    graph.add_nodes_from(isolated)
    graph.add_weighted_edges_from([(src, dst, round(amount * 100)) for src, dst, amount in edges], weight="cents")
    members = set(graph.nodes) if members is None else set(members)
    nodes = {str(gid): {"is_seed": gid in seeds, "boundary": gid in boundary} for gid in graph}
    return explain_cluster(graph, members, nodes)


@pytest.mark.parametrize("edges,expected", [
    ([(1, 4, 5000), (2, 4, 5000), (3, 4, 5000)], "collection"),
    ([(4, 1, 5000), (4, 2, 5000), (4, 3, 5000)], "distribution"),
    ([(1, 2, 10000), (2, 3, 10000)], "transit"),
    ([(1, 4, 5000), (2, 4, 5000), (3, 4, 5000), (4, 5, 15000),
      (5, 6, 5000), (5, 7, 5000), (5, 8, 5000)], "mixed"),
    ([(1, 2, 5000)], "undetermined"),
])
def test_group_purpose_from_directed_motifs(edges, expected):
    explanation = group_explanation(edges)
    assert explanation["kind"] == expected
    assert explanation["metrics"]["internal_amount"] == sum(amount for _, _, amount in edges)
    assert explanation["evidence"] and explanation["rule"] and explanation["limitations"]
    assert "Преобладающая" not in " ".join(explanation["evidence"])
    assert explanation == group_explanation(list(reversed(edges)))


def test_group_motif_thresholds_and_amount_support():
    # Three senders are necessary; a two-sender star is insufficient.
    assert group_explanation([(1, 4, 5000), (2, 4, 5000)])["kind"] == "undetermined"
    star = [(1, 4, 5000), (2, 4, 5000), (3, 4, 5000)]
    # A tiny fan inside a larger group must not determine its entire purpose.
    assert group_explanation(star + [(5, 6, 45000)])["kind"] == "collection"
    assert group_explanation(star + [(5, 6, 45000.01)])["kind"] == "undetermined"
    assert group_explanation([(1, 4, 8300), (2, 4, 8300), (3, 4, 8300), (5, 6, 75100)])["kind"] == "undetermined"
    # Inclusive balance threshold; no collection/distribution in a chain.
    assert group_explanation([(1, 2, 10000), (2, 3, 8000)])["kind"] == "transit"
    assert group_explanation([(1, 2, 10000), (2, 3, 7999.99)])["kind"] == "undetermined"
    assert group_explanation([(1, 2, 10000), (2, 3, 7990)])["kind"] == "undetermined"
    assert group_explanation([(1, 2, 25000), (2, 3, 25000), (4, 5, 50000)])["kind"] == "transit"
    assert group_explanation([(1, 2, 24900), (2, 3, 24900), (4, 5, 50200)])["kind"] == "undetermined"
    # Sums crossing the community boundary are context, not invented internal motifs.
    result = group_explanation([(9, 1, 7000), (1, 2, 10000), (2, 3, 10000), (3, 10, 8000)], members={1, 2, 3})
    assert result["incoming_amount"] == 7000 and result["outgoing_amount"] == 8000
    assert result["metrics"]["internal_amount"] == 20000
    assert result["metrics"]["transit_share"] == .5


def test_group_isolates_boundary_seed_and_self_transfers():
    isolated = group_explanation([], isolated=[1], seeds=[1])
    assert isolated["kind"] == "undetermined"
    assert isolated["metrics"]["internal_amount"] == 0
    assert "связей 0" in isolated["evidence"][0]
    assert any("входящие потоки неполны" in text for text in isolated["limitations"])
    chain = [(1, 2, 10000), (2, 3, 10000)]
    for flags in [{"seeds": [2]}, {"boundary": [2]}]:
        result = group_explanation(chain, **flags)
        assert result["kind"] == "undetermined" and result["metrics"]["transit_nodes"] == 0
    boundary_collector = group_explanation([(1, 4, 5000), (2, 4, 5000), (3, 4, 5000)], boundary=[4], seeds=[1, 2])
    assert boundary_collector["kind"] == "collection"
    assert boundary_collector["metrics"]["seed_nodes"] == 2
    assert any("не доказывает удержание" in text for text in boundary_collector["limitations"])
    self_transfer = group_explanation([(1, 1, 5000)])
    assert self_transfer["kind"] == "undetermined"
    assert self_transfer["metrics"]["internal_edges"] == 0
    assert self_transfer["metrics"]["internal_amount"] == 5000


def test_group_cycle_is_explained_without_claiming_unique_funds():
    result = group_explanation([(1, 2, 5000), (2, 3, 5000), (3, 1, 5000)])
    assert result["kind"] == "transit"
    assert result["metrics"]["transit_share"] == 1
    assert result["metrics"]["transit_amount"] == 15000
    assert any("у нескольких участников" in text for text in result["limitations"])


def test_real_group_explanations_and_exports_are_consistent(analysis, outputs):
    rows = pd.read_csv(outputs / "clusters.csv")
    assert list(rows.columns) == ["cluster_id", "n_nodes", "n_seed", "sum_kzt_internal", "top_gids", "hypothesis"]
    cluster_by_id = {c["cluster_id"]: c for c in analysis["clusters"]}
    node_cluster = {n["gid"]: n["cluster_id"] for n in analysis["nodes"]}
    for row in rows.itertuples():
        cluster = cluster_by_id[row.cluster_id]
        detail = cluster["explanation"]
        assert row.hypothesis == cluster["hypothesis"]
        assert cluster["hypothesis"] == " ".join([detail["purpose"] + ".", *detail["evidence"], *detail["limitations"]])
        assert detail["metrics"]["internal_amount"] == cluster["sum_kzt_internal"]
        incoming = sum(Decimal(str(e["amount"])) for e in analysis["edges"]
                       if node_cluster[e["src"]] != row.cluster_id == node_cluster[e["dst"]])
        outgoing = sum(Decimal(str(e["amount"])) for e in analysis["edges"]
                       if node_cluster[e["dst"]] != row.cluster_id == node_cluster[e["src"]])
        assert incoming == Decimal(str(detail["incoming_amount"]))
        assert outgoing == Decimal(str(detail["outgoing_amount"]))
        assert detail["thresholds"] == analysis["manifest"]["parameters"]["cluster_hypothesis_thresholds"]
    json.dumps(analysis["clusters"], allow_nan=False)
