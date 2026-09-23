from pathlib import Path

import pandas as pd
import pytest

from moneygraph.analysis import load_and_analyze, write_outputs

DATA = Path(__file__).resolve().parents[1] / "data"


@pytest.fixture(scope="session")
def frames():
    return [pd.read_parquet(DATA / f"{name}.parquet") for name in ("nodes", "edges", "transactions")]


@pytest.fixture(scope="session")
def analysis():
    return load_and_analyze(DATA)


@pytest.fixture(scope="session")
def outputs(analysis, tmp_path_factory):
    out = tmp_path_factory.mktemp("results")
    write_outputs(analysis, out)
    return out
