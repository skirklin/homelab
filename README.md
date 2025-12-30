# Book Editor

A tool for writers to analyze manuscripts for continuity errors, plot holes, and structural issues using AI.

## Design Philosophy

The system uses a **hybrid approach** that combines systematic extraction with agentic reasoning:

### Why Hybrid?

Early versions tried to detect issues with code-based pattern matching (e.g., "if character has attribute X in chunk 1 and attribute Y in chunk 5, flag inconsistency"). This approach is fragile because:

- **Context matters**: A character described as "young" in chapter 1 and "gray-haired" in chapter 20 might be a continuity error, or might be a 30-year time jump. Code can't tell the difference.
- **Semantic matching is hard**: Is "the old lighthouse" the same as "Marcus's tower"? Is "Monday evening" before or after "the night of the storm"?
- **Narrative conventions vary**: Flashbacks, unreliable narrators, and intentional ambiguity break simple heuristics.

### The Solution: Extraction + Agentic Reasoning

```
┌─────────────────────────────────────────────────────────────────┐
│                     SYSTEMATIC EXTRACTION                        │
│  (Deterministic, cacheable, builds a queryable "database")      │
├─────────────────────────────────────────────────────────────────┤
│  1. Parse document (chapters, paragraphs)                        │
│  2. Chunk into ~5k word sections                                 │
│  3. Discovery pass: identify all characters, plot threads        │
│  4. Extraction pass: per-chunk extraction via Batch API (50% $) │
│  5. Aggregation: merge into unified entity profiles              │
│  6. Timeline reconstruction (model-assisted)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      AGENTIC REASONING                           │
│  (Literary critic with tools, handles nuanced judgments)        │
├─────────────────────────────────────────────────────────────────┤
│  The critic agent can:                                           │
│  • search_characters, search_events, search_facts               │
│  • get_character_details, compare_character_timelines           │
│  • read_chunk (access source text to verify)                    │
│  • get_plot_threads, get_existing_issues                        │
│  • report_insight (findings with evidence)                      │
│                                                                  │
│  The agent reasons about:                                        │
│  • Are these contradictions or intentional narrative choices?   │
│  • Do character arcs make sense given story context?            │
│  • Are setups paid off in ways the extraction missed?           │
│  • What's a real plot hole vs. intentional mystery?             │
└─────────────────────────────────────────────────────────────────┘
```

### What Each Layer Does

| Task | Handled By | Why |
|------|-----------|-----|
| Parsing, chunking | Code | Deterministic text processing |
| Entity extraction | Model (Batch API) | Needs language understanding; 50% cost savings |
| Entity deduplication | Code + heuristics | "Emma" = "Miss Hartley" can be fuzzy-matched |
| Timeline ordering | Model | Needs to understand "three days before the murder" |
| Character inconsistencies | **Critic agent** | Needs full context to judge |
| Plot hole detection | **Critic agent** | Needs narrative understanding |
| Setup/payoff matching | **Critic agent** | Semantic similarity + story logic |

### Cost Optimization

The extraction phase uses Anthropic's [Message Batches API](https://docs.anthropic.com/en/docs/build-with-claude/message-batches) for 50% cost reduction. All chunks are submitted as a single batch and processed in parallel by the API.

### Caching

Each phase is cached by content hash:
- **Chunks**: Cached per document (invalidated if text changes)
- **Discovery**: Cached per document + model
- **Extraction**: Cached per chunk + model + discovered entities

This enables fast iteration: change the critic prompts without re-running extraction.

## Installation

```bash
# Create conda environment
conda create -n book python=3.11
conda activate book

# Install the critic package
pip install -e .
```

## Usage

### Analyze a manuscript

```bash
# Basic analysis (extraction only)
critic analyze manuscript.docx -o analysis.json

# With literary critic agent
critic analyze manuscript.docx -o analysis.json --critic

# Verbose output
critic analyze manuscript.docx -v --critic
```

### Run critic on existing analysis

```bash
# Run critic agent separately
critic critic analysis.json -v

# Focus on specific areas
critic critic analysis.json --focus "character arcs,timeline"
```

### Other commands

```bash
# Preview document structure (no API calls)
critic parse manuscript.docx
critic chunk manuscript.docx

# Manage cache
critic cache --stats
critic cache --clear
```

## Project Structure

```
critic/
├── app/                    # React frontend (Vite + TypeScript)
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── context/        # React context for analysis state
│   │   └── types/          # TypeScript types matching schema
│   └── dist/               # Build output
├── critic/                 # Python analysis engine
│   ├── parser.py           # Document parsing (.docx, .md, .txt)
│   ├── chunker.py          # Smart chunking by chapters/size
│   ├── discovery.py        # First pass: find all entities
│   ├── extractor.py        # Second pass: detailed extraction
│   ├── aggregator.py       # Merge extractions into profiles
│   ├── timeline.py         # Chronological reconstruction
│   ├── analyzer.py         # Main orchestration
│   ├── critic.py           # Literary critic agent + tools
│   ├── cache.py            # Content-hash based caching
│   ├── schema.py           # Pydantic models (JSON output)
│   └── cli.py              # Command-line interface
├── test-manuscripts/       # Sample manuscripts for testing
├── pyproject.toml          # Python package config
└── firebase.json           # Firebase hosting config
```

## Output Schema

The analysis produces a JSON file with:

- **document**: Title, word count, chapter count
- **chunks**: Full text with per-chunk extractions
- **entities**: Characters, locations, objects with profiles
- **timeline**: Chronological events with entity timelines
- **plot_threads**: Story arcs with lifecycle (introduced → resolved)
- **issues**: Detected problems with evidence and severity

See `critic/schema.py` for full Pydantic models.

## Frontend

The React frontend visualizes analysis results:

```bash
cd app
npm install
npm run dev    # http://localhost:5173
npm run build  # Build for deployment
```

## Deployment

```bash
firebase deploy --only hosting
```

- **URL**: https://editor-5d5a3.web.app
- **Custom Domain**: `editor.kirkl.in` (pending DNS)

## Configuration

Set your Anthropic API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or for the frontend (via Firebase Functions), the key is stored as a Firebase secret.
