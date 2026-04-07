# Python ingest server
FROM python:3.12-slim

RUN pip install uv
WORKDIR /app

COPY services/ingest/pyproject.toml services/ingest/uv.lock ./
COPY services/ingest/src/ src/
COPY services/ingest/.python-version ./
RUN touch README.md && uv sync --frozen || uv sync

EXPOSE 5555
CMD ["uv", "run", "money", "serve"]
