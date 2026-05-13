# ingest

Python backend for money / financial data ingestion. Managed with [uv](https://docs.astral.sh/uv/).

## Running tests

From the repo root:

```bash
pnpm test:ingest
```

This unsets a stray `VIRTUAL_ENV` (so conda activations don't poison uv's project venv),
runs `uv sync --group dev`, and then invokes `pytest`. Extra args pass through to pytest:

```bash
# Run a single file
pnpm test:ingest tests/test_identity.py

# Run by keyword
pnpm test:ingest -k ally

# Verbose
pnpm test:ingest -v
```

If you prefer to work inside `services/ingest/` directly:

```bash
cd services/ingest
env -u VIRTUAL_ENV uv sync --group dev
env -u VIRTUAL_ENV uv run pytest
```
