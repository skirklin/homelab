# Python ingest server
FROM python:3.12-slim

RUN pip install uv && apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY services/ingest/pyproject.toml services/ingest/uv.lock ./
COPY services/ingest/src/ src/
COPY services/ingest/.python-version ./
RUN touch README.md && uv sync --frozen || uv sync

# Bundle the Chrome extension into the image (raw files for install script, zip for download)
COPY extension/ /app/extension-src/
RUN mkdir -p /app/extension-dist \
    && cd /app/extension-src \
    && zip -r /app/extension-dist/money-collector.zip . -x '.*' -x '__MACOSX/*' -x 'node_modules/*' \
    && python3 -c "import json; print(json.load(open('manifest.json'))['version'])" > /app/extension-dist/version.txt

EXPOSE 5555

# Copy entrypoint that seeds config on first run
COPY infra/docker/ingest-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

CMD ["/app/entrypoint.sh"]
