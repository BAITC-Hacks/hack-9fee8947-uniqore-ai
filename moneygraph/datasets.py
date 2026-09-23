"""Bounded, temporary imports and independent in-memory analysis snapshots."""
from __future__ import annotations

import secrets
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import HTTPException, Request
from starlette.datastructures import UploadFile

from .analysis import DataError, OUTPUTS, load_and_analyze, verify_outputs, write_outputs

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_REQUEST_BYTES = 30 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
MAX_ROWS = {"nodes": 5_000, "edges": 20_000, "transactions": 100_000}
COLUMNS = {"nodes": {"gid", "depth", "is_seed"},
           "edges": {"src", "dst", "sum_kzt", "n_tx", "depth"},
           "transactions": {"src", "dst", "date", "sum_kzt"}}
DATASET_TTL_SECONDS = 3600
MAX_DATASETS = 4


@dataclass
class Snapshot:
    result: dict
    exports: dict[str, bytes]
    expires_at: float | None = None
    node_index: dict = field(init=False)
    graph_nodes: list = field(init=False)
    graph_node_index: dict = field(init=False)
    transactions: dict = field(init=False)
    neighbors: dict = field(init=False)

    def __post_init__(self):
        self.node_index = {n["gid"]: n for n in self.result["nodes"]}
        self.graph_nodes = [{k: v for k, v in n.items() if k != "role_explanation"} for n in self.result["nodes"]]
        self.graph_node_index = {n["gid"]: n for n in self.graph_nodes}
        self.transactions = {gid: [] for gid in self.node_index}
        for tx in self.result["transactions"]:
            self.transactions[tx["src"]].append(tx)
            if tx["src"] != tx["dst"]:
                self.transactions[tx["dst"]].append(tx)
        self.neighbors = {gid: set() for gid in self.node_index}
        for edge in self.result["edges"]:
            self.neighbors[edge["src"]].add(edge["dst"])
            self.neighbors[edge["dst"]].add(edge["src"])

    def node(self, gid: str):
        if gid not in self.node_index:
            raise HTTPException(404, "Клиент не найден в этом наборе данных.")
        return self.node_index[gid]


class DatasetStore:
    def __init__(self, startup: Snapshot):
        self.startup = startup
        self.uploaded: dict[str, Snapshot] = {}
        self.lock = threading.Lock()
        self.import_lock = threading.Lock()

    def _expire(self):
        now = time.monotonic()
        self.uploaded = {key: value for key, value in self.uploaded.items()
                         if value.expires_at is not None and value.expires_at > now}

    def select(self, dataset_id: str | None):
        with self.lock:
            self._expire()
            if dataset_id is None:
                return self.startup
            if dataset_id not in self.uploaded:
                raise HTTPException(410, "Загруженный набор больше недоступен. Загрузите файлы повторно или вернитесь к исходному набору.")
            return self.uploaded[dataset_id]

    def ensure_capacity(self):
        with self.lock:
            self._expire()
            if len(self.uploaded) >= MAX_DATASETS:
                raise HTTPException(429, "Достигнут лимит временных наборов. Вернитесь к исходному набору, чтобы освободить текущий, или дождитесь удаления через час.")

    def add(self, snapshot: Snapshot):
        with self.lock:
            dataset_id = secrets.token_urlsafe(32)
            snapshot.expires_at = time.monotonic() + DATASET_TTL_SECONDS
            self.uploaded[dataset_id] = snapshot
            return dataset_id

    def remove(self, dataset_id: str | None):
        with self.lock:
            self._expire()
            if dataset_id is None:
                return
            if dataset_id not in self.uploaded:
                raise HTTPException(410, "Загруженный набор уже удалён или срок его хранения истёк.")
            del self.uploaded[dataset_id]


async def bounded_body(request: Request) -> bytes:
    """Bound the entire multipart message even without a truthful Content-Length."""
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "multipart/form-data":
        raise HTTPException(415, "Отправьте три Parquet-файла как multipart/form-data.")
    length = request.headers.get("content-length")
    if length is not None:
        try:
            declared = int(length)
        except ValueError as exc:
            raise HTTPException(400, "Некорректный размер запроса.") from exc
        if declared < 0:
            raise HTTPException(400, "Некорректный размер запроса.")
        if declared > MAX_REQUEST_BYTES:
            raise HTTPException(413, "Общий размер загрузки, включая служебные поля, не должен превышать 30 МиБ.")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_REQUEST_BYTES:
            raise HTTPException(413, "Общий размер загрузки, включая служебные поля, не должен превышать 30 МиБ.")
        body.extend(chunk)
    return bytes(body)


def inspect_parquet(path: Path, name: str):
    """Check bounded metadata and scalar schema before any dataframe decoding."""
    with pq.ParquetFile(path, thrift_string_size_limit=256 * 1024,
                        thrift_container_size_limit=100_000) as parquet:
        meta, schema = parquet.metadata, parquet.schema_arrow
        if meta.num_rows > MAX_ROWS[name]:
            raise HTTPException(413, f"{name}.parquet: максимум {MAX_ROWS[name]:,} строк.".replace(",", " "))
        if len(schema) != len(COLUMNS[name]) or set(schema.names) != COLUMNS[name]:
            raise DataError(f"{name}.parquet: ожидаются только поля {', '.join(sorted(COLUMNS[name]))}.")
        uncompressed = sum(meta.row_group(i).column(j).total_uncompressed_size
                           for i in range(meta.num_row_groups) for j in range(meta.num_columns))
        if uncompressed > MAX_UNCOMPRESSED_BYTES:
            raise HTTPException(413, f"{name}.parquet: размер после распаковки превышает 64 МиБ.")
        for column in schema:
            kind = column.type
            if column.name in {"gid", "src", "dst", "depth", "n_tx"}:
                valid = pa.types.is_integer(kind)
            elif column.name == "is_seed":
                valid = pa.types.is_boolean(kind)
            elif column.name == "sum_kzt":
                valid = pa.types.is_integer(kind) or pa.types.is_floating(kind)
            else:  # date: textual dates remain subject to calendar validation.
                valid = (pa.types.is_date(kind) or pa.types.is_string(kind) or
                         (pa.types.is_timestamp(kind) and kind.tz is None))
            if not valid:
                raise DataError(f"{name}.{column.name}: неподдерживаемый тип данных.")


def calculate_upload(files: dict[str, UploadFile]) -> Snapshot:
    started = time.perf_counter()
    # Both original files and generated outputs disappear on every exit path.
    with tempfile.TemporaryDirectory(prefix="tyuin-upload-") as temporary:
        data = Path(temporary)
        for name, upload in files.items():
            path = data / f"{name}.parquet"
            size = 0
            with path.open("wb") as target:
                while chunk := upload.file.read(64 * 1024):
                    size += len(chunk)
                    if size > MAX_FILE_BYTES:
                        raise HTTPException(413, f"{name}.parquet: максимальный размер файла — 10 МиБ.")
                    target.write(chunk)
            if not size:
                raise DataError(f"{name}.parquet: файл пуст.")
            inspect_parquet(path, name)
        result = load_and_analyze(data)
        out = data / "results"
        write_outputs(result, out)
        verify_outputs(data, out)
        result["manifest"]["verification"] = {"status": "passed"}
        result["manifest"]["full_run_seconds"] = round(time.perf_counter() - started, 4)
        return Snapshot(result, {name: (out / name).read_bytes() for name in OUTPUTS})
