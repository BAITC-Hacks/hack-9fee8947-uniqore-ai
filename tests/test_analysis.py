import math
from collections import Counter
from decimal import Decimal

import pandas as pd
import pytest

from moneygraph.analysis import DataError, analyze, temporal_match, validate_frames, verify_outputs
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


def test_csv_contract_and_tampering(outputs, tmp_path):
    assert verify_outputs(DATA, outputs) == {"status": "ok", "analysis_id": "ad6239d9995448b0", "nodes": 2248, "clusters": 88, "top": 20}
    for file in outputs.iterdir():
        (tmp_path / file.name).write_bytes(file.read_bytes())
    with (tmp_path / "top_nodes.csv").open("a") as f:
        f.write("\n")
    with pytest.raises(DataError, match="контрольная сумма"):
        verify_outputs(DATA, tmp_path)
