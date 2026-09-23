FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.lock ./
RUN python -m pip install --no-cache-dir -r requirements.lock

RUN groupadd --gid 10001 tyuin \
    && useradd --uid 10001 --gid tyuin --create-home tyuin \
    && mkdir /app/out \
    && chown tyuin:tyuin /app/out
COPY moneygraph/ ./moneygraph/
COPY data/*.parquet ./data/

USER 10001:10001
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
    CMD ["python", "-c", "import json, urllib.request; r = json.load(urllib.request.urlopen('http://127.0.0.1:8765/api/health', timeout=3)); assert r['status'] == 'ok'"]

CMD ["python", "-m", "moneygraph", "demo", "--data", "/app/data", "--out", "/app/out", "--host", "0.0.0.0", "--port", "8765"]
