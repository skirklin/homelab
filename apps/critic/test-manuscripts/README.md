# Test Manuscripts

Test documents for developing and validating the book analysis tool.

## Directory Structure

```
test-manuscripts/
├── synthetic/          # Intentionally flawed manuscripts with known errors
│   └── the-lighthouse-keeper/
│       ├── manifest.json
│       ├── manuscript.md
│       ├── manuscript.docx
│       └── expected-issues.json
│
└── gutenberg/          # Real books from Project Gutenberg
    └── wuthering-heights/
        ├── manifest.json
        └── manuscript.txt
```

## Manifest Schema

Each book directory **must** contain a `manifest.json` file:

```json
{
  "title": "The Lighthouse Keeper",
  "type": "synthetic|gutenberg|user",
  "source": {
    "type": "original|gutenberg|upload",
    "id": "768",
    "url": "https://www.gutenberg.org/ebooks/768"
  },
  "files": {
    "manuscript": "manuscript.txt",
    "manuscriptFormats": ["manuscript.md", "manuscript.docx"],
    "expectedIssues": "expected-issues.json"
  },
  "metadata": {
    "author": "Emily Brontë",
    "year": 1847,
    "wordCount": 107945,
    "chapterCount": 34
  }
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Human-readable title |
| `type` | enum | `synthetic` (intentional errors), `gutenberg` (public domain), `user` (uploaded) |
| `files.manuscript` | string | Primary manuscript file (relative path) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `source` | object | Origin info for downloaded books |
| `files.manuscriptFormats` | string[] | Alternative formats of the same manuscript |
| `files.expectedIssues` | string | Ground truth issues for validation (synthetic only) |
| `metadata` | object | Author, year, word count, etc. |

## Expected Issues Schema (Synthetic Only)

For synthetic test manuscripts, `expected-issues.json` documents known errors:

```json
{
  "issues": [
    {
      "type": "character_inconsistency",
      "severity": "error",
      "title": "Rachel's eye color changes",
      "description": "Green eyes in Ch 3, blue eyes in Ch 4",
      "locations": [
        { "chapter": 3, "quote": "striking red hair and green eyes" },
        { "chapter": 4, "quote": "Her eyes were blue" }
      ]
    }
  ]
}
```

This allows automated comparison of detected issues against ground truth.

## Validation

The CLI validates manuscript directories before processing:

```bash
critic validate test-manuscripts/synthetic/the-lighthouse-keeper
```

Checks performed:
- `manifest.json` exists and is valid JSON
- Required fields are present
- Referenced files exist
- For synthetic: `expectedIssues` file exists and is valid

## Adding New Books

### From Project Gutenberg

```bash
cd core && node dist/cli.js gutenberg 1342 -o ../test-manuscripts/gutenberg
```

This creates a properly structured directory with manifest.

### Synthetic Test Documents

1. Create directory: `test-manuscripts/synthetic/my-test/`
2. Add `manuscript.md` or `.txt` with intentional errors
3. Create `manifest.json` with `type: "synthetic"`
4. Document errors in `expected-issues.json`
