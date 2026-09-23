"""Custom inputs exercise calendar aggregation and numeric validation."""
from datetime import date

import pandas as pd
import pytest

from moneygraph.analysis import DataError, analyze, validate_frames


def custom_frames(dates=("2027-12-31", "2028-01-01")):
    # IDs above JS's exact-number range must survive the full result as strings.
    a, b, c, isolated = [9_007_199_254_741_000 + i for i in range(4)]
    nodes = pd.DataFrame({"gid": [a, b, c, isolated], "depth": [0, 1, 2, 0],
                          "is_seed": [True, False, False, True]})
    edges = pd.DataFrame({"src": [a, b], "dst": [b, c], "sum_kzt": [10000., 10000.],
                          "n_tx": [1, 1], "depth": [1, 2]})
    tx = pd.DataFrame({"src": [a, b], "dst": [b, c], "date": list(dates), "sum_kzt": [10000., 10000.]})
    return nodes, edges, tx


@pytest.mark.parametrize("dates,period", [
    (("2027-12-31", "2028-01-01"), ("2027-12-31", "2028-01-01")),
    ((date(2028, 2, 29), date(2028, 2, 29)), ("2028-02-29", "2028-02-29")),
    (("2028-01-01", "2028-12-31"), ("2028-01-01", "2028-12-31")),
    (("2028-02-29 23:15:00", "2028-03-01 00:30:00"), ("2028-02-29", "2028-03-01")),
])
def test_custom_calendar_period_and_int64_identity(dates, period):
    result = analyze(*custom_frames(dates))
    assert (result["summary"]["period_start"], result["summary"]["period_end"]) == period
    assert result["summary"]["n_nodes"] == 4
    assert result["summary"]["n_isolated"] == 1
    assert {n["gid"] for n in result["nodes"]} == {str(9_007_199_254_741_000 + i) for i in range(4)}
    assert not any("июл" in text for n in result["nodes"] for text in n["limitations"])


def test_timestamp_normalization_combines_daily_totals():
    nodes, edges, tx = custom_frames(("2028-02-29 01:00", "2028-02-29 23:00"))
    # Two original operations from the same pair remain distinct, aggregate once.
    tx.loc[1, ["src", "dst"]] = tx.loc[0, ["src", "dst"]]
    edges = edges.iloc[:1].copy()
    edges.loc[0, ["sum_kzt", "n_tx"]] = [20000., 2]
    result = analyze(nodes, edges, tx)
    assert result["daily"] == [{"date": "2028-02-29", "amount": 20000., "n_tx": 2}]
    assert result["edges"][0]["daily"] == result["daily"]
    assert len(result["transactions"]) == 2


@pytest.mark.parametrize("dates", [
    ("2028-01-01", "2029-01-01"),  # 367 calendar days inclusive
    ("2028-01-01T00:00:00Z", "2028-01-02T00:00:00Z"),
    ("2028-01-01", "2028-01-02T00:00:00+06:00"),
    (20280101, 20280102),
    ("NaT", "2028-01-02"),
])
def test_unsupported_dates_are_actionable(dates):
    with pytest.raises(DataError, match="date|Период"):
        validate_frames(*custom_frames(dates))


@pytest.mark.parametrize("problem", ["empty", "string_money", "overflow_sum", "uint64_gid"])
def test_unsafe_inputs_fail_before_graph_calculation(problem):
    nodes, edges, tx = custom_frames()
    if problem == "empty":
        tx = tx.iloc[:0]
    elif problem == "string_money":
        tx["sum_kzt"] = tx.sum_kzt.astype(str)
    elif problem == "overflow_sum":
        # Each amount fits signed int64 tiyn; the total does not.
        tx["sum_kzt"] = [5e16, 5e16]
    elif problem == "uint64_gid":
        nodes["gid"] = pd.Series([2**63, 2**63+1, 2**63+2, 2**63+3], dtype="uint64")
    with pytest.raises(DataError):
        validate_frames(nodes, edges, tx)
