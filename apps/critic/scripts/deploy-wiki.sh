#!/bin/bash
# Deploy manuscript wikis to Firebase Hosting
#
# Usage:
#   ./scripts/deploy-wiki.sh                    # Deploy all
#   ./scripts/deploy-wiki.sh wuthering-heights  # Deploy specific manuscript

set -e

# Ensure public directory exists
mkdir -p public

# Generate index
generate_index() {
    echo "Generating index..."
    cat > public/index.html << 'INDEXHTML'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Manuscript Analysis Wiki</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 2rem auto;
      padding: 0 1rem;
      line-height: 1.6;
    }
    h1 { border-bottom: 2px solid #333; padding-bottom: 0.5rem; }
    ul { list-style: none; padding: 0; }
    li { margin: 1rem 0; }
    a { color: #0066cc; text-decoration: none; font-size: 1.2rem; }
    a:hover { text-decoration: underline; }
    .meta { color: #666; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Manuscript Analysis Wiki</h1>
  <p>AI-powered literary analysis with continuity checking, character tracking, and timeline extraction.</p>
  <h2>Available Analyses</h2>
  <ul>
INDEXHTML

    # Add entries for each wiki
    for dir in public/gutenberg/*/; do
        if [ -d "$dir" ]; then
            name=$(basename "$dir")
            title=$(grep -o '<h1>[^<]*</h1>' "$dir/index.html" 2>/dev/null | sed 's/<[^>]*>//g' || echo "$name")
            echo "    <li><a href=\"gutenberg/$name/\">$title</a></li>" >> public/index.html
        fi
    done

    cat >> public/index.html << 'INDEXHTML'
  </ul>
  <footer style="margin-top: 3rem; color: #666; font-size: 0.85rem;">
    Generated with <a href="https://github.com/anthropics/claude-code">Claude Code</a>
  </footer>
</body>
</html>
INDEXHTML
}

# Deploy a specific manuscript
deploy_manuscript() {
    local name=$1
    local analysis_json="test-manuscripts/gutenberg/$name/analysis-v3.json"
    local output_dir="public/gutenberg/$name"

    if [ ! -f "$analysis_json" ]; then
        echo "Analysis not found: $analysis_json"
        echo "Run: python -m critic.cli analyze test-manuscripts/gutenberg/$name/manuscript.txt -o $analysis_json"
        return 1
    fi

    echo "Generating wiki for $name..."
    mkdir -p "$output_dir"
    python -m critic.cli wiki "$analysis_json" --from-json -o "$output_dir"
}

# Main
if [ -n "$1" ]; then
    deploy_manuscript "$1"
else
    # Deploy all manuscripts with analysis-v3.json
    for analysis in test-manuscripts/gutenberg/*/analysis-v3.json; do
        if [ -f "$analysis" ]; then
            name=$(basename $(dirname "$analysis"))
            deploy_manuscript "$name"
        fi
    done
fi

generate_index

echo ""
echo "Wiki files ready in public/"
echo ""
echo "To deploy to Firebase:"
echo "  firebase deploy --only hosting:critic"
echo ""
echo "Or preview locally:"
echo "  cd public && python3 -m http.server 8080"
