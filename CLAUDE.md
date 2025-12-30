# Claude Context for Critic

## Project Overview

A manuscript analysis tool that detects continuity errors, plot holes, and structural issues using a hybrid extraction + agentic reasoning approach.

## Architecture

The system has two main components:

1. **`critic/` - Python analysis engine** (CLI tool)
   - Parses manuscripts (.docx, .md, .txt)
   - Extracts entities, events, facts, dialogue via Claude API
   - Literary critic agent reasons over extracted data
   - Outputs JSON for frontend consumption

2. **`app/` - React frontend** (visualization)
   - Displays analysis results
   - Character views, timeline views, issue browser

## Key Design Principle

**Use models for judgment, code for plumbing.**

- Fragile: Code that pattern-matches "blue eyes in chunk 1, brown eyes in chunk 5 = inconsistency"
- Robust: Model extracts facts, critic agent judges if they're contradictions given context

See README.md for full design rationale.

## Development

### Python (critic CLI)

```bash
conda activate book
pip install -e .

# Analyze a manuscript
critic analyze manuscript.md -o output.json -v

# Run critic agent on existing analysis
critic critic output.json -v

# Cache management
critic cache --stats
critic cache --clear
```

### Frontend

```bash
cd app
npm install
npm run dev    # localhost:5173
npm run build
```

## Project Structure

```
critic/
├── critic/                 # Python package
│   ├── analyzer.py         # Main orchestration
│   ├── parser.py           # Document parsing
│   ├── chunker.py          # Text chunking
│   ├── discovery.py        # Entity discovery pass
│   ├── extractor.py        # Detailed extraction pass
│   ├── aggregator.py       # Merge into entity profiles
│   ├── timeline.py         # Chronological reconstruction
│   ├── critic.py           # Literary critic agent + tools
│   ├── cache.py            # Content-hash caching
│   ├── schema.py           # Pydantic output models
│   └── cli.py              # Click CLI
├── app/                    # React frontend
│   ├── src/components/     # UI components
│   ├── src/context/        # Analysis state
│   └── src/types/          # TypeScript types
├── test-manuscripts/       # Test data
├── pyproject.toml          # Python package config
└── firebase.json           # Hosting config
```

## Caching

Analysis results are cached in `.critic-cache/`:
- Chunks (per document hash)
- Discovery results (per document + model)
- Extraction results (per chunk + model + entity context)

This allows fast iteration on prompts without re-running expensive extraction.

## Environment

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Deployment

```bash
firebase deploy --only hosting
```

- **URL**: https://editor-5d5a3.web.app
- **Firebase Project**: `recipe-box-335721` (shared)

## Current Status

Working:
- Full extraction pipeline with caching
- Literary critic agent with 13 tools
- Timeline reconstruction
- React frontend with multiple views

Pending:
- Setup/payoff matching improvements
- Frontend polish
