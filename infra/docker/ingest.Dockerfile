# Python ingest server
FROM python:3.12-slim

RUN pip install uv
WORKDIR /app

COPY services/ingest/pyproject.toml services/ingest/uv.lock ./
RUN uv sync --frozen || uv sync

COPY services/ingest/src/ src/

EXPOSE 5555
CMD ["uv", "run", "money", "serve"]
