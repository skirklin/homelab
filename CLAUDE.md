# Money — Personal Finance Dashboard

## Project Overview
Local-first personal finance tool. Scrapes financial institutions, stores raw + normalized data in SQLite, serves a React dashboard.

## Architecture
- **Backend**: Python, SQLite, no ORM (dataclasses + raw SQL)
- **Frontend**: React 19 + TypeScript + Vite + Recharts
- **Extension**: Chrome MV3 extension for capturing cookies/network data from bank sites
- **Server**: Simple HTTP server on port 5555 (`src/money/server.py`)

### Directory Layout
- `src/money/` — main Python package
- `src/money/ingest/scrapers/` — Playwright scrapers per institution
- `src/money/ingest/parsers/` — CSV/file parsers per institution
- `src/money/ingest/{institution}.py` — orchestrates scrape → store → parse → DB
- `frontend/` — React dashboard (Vite)
- `frontend/src/pages/` — route pages (Overview, Investments, Spending)
- `frontend/src/components/` — shared chart/table components
- `extension/` — Chrome extension for data collection

### Data Model
- **Account-level aggregation** — balances, performance_history (invested/earned), transactions
- **No holdings/positions table yet** — can't break down by ticker, asset class, or market
- Tables: accounts, balances, transactions, performance_history, option_grants, private_valuations, ingestion_log

## Tooling
- `uv` for Python package management
- `ruff` for lint/format (line-length 100)
- `pyright` strict mode for type checking
- `pytest` for tests
- Dev deps: `uv sync --all-extras`
- Frontend: `npm run dev` from `frontend/`

## Code Style
- No `type: ignore` / `pyright: ignore` unless genuinely untyped third-party lib
- No inline Python (`python -c`) — always write files
- Keep things simple, avoid over-engineering

## Current State (March 2026)
- Ally Bank: scraper + CSV parser built
- Betterment, Wealthfront, Morgan Stanley, Capital One: ingestion in progress
- Dashboard: 3-page layout (Overview, Investments, Spending) with routing

## Planned Work

### Holdings-Level Portfolio Data
The DB currently only tracks account-level balances and aggregate performance. To support portfolio composition analysis (by asset class, market, sector, etc.), we need:
1. A `holdings` table (ticker/symbol, shares, cost_basis, asset_class, market, sector)
2. Ingestion logic per brokerage to populate holdings from scraped data
3. Frontend views for composition breakdowns, cross-brokerage comparison

The user especially wants to compare Betterment vs Wealthfront investment performance.

### Transaction Attribution (AI-Powered)
Transaction descriptions from banks are cryptic. Plan is to use the Anthropic API (Claude) to categorize transactions automatically. The `category` field exists in the transactions table but is mostly unpopulated. Design spending features with rich categorization in mind.

### Frontend Improvements
- Portfolio composition by asset class/market/sector (blocked on holdings table)
- Cross-institution performance comparison charts
- Better empty states for accounts with no data
- Global time range filter
- Data refresh after ingestion (currently requires page reload)
