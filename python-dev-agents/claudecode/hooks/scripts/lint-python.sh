#!/usr/bin/env bash
# Post-tool hook: runs ruff check on Python files after Write/Edit
# Only runs if the modified file is a .py file

set -euo pipefail

# The tool result is passed via stdin as JSON
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys, json; data = json.load(sys.stdin); print(data.get('tool_result', {}).get('filePath', data.get('tool_input', {}).get('file_path', '')))" 2>/dev/null || echo "")

# Only lint Python files
if [[ "$FILE_PATH" == *.py ]]; then
    if command -v ruff &> /dev/null; then
        ruff check --fix "$FILE_PATH" 2>/dev/null || true
        ruff format "$FILE_PATH" 2>/dev/null || true
    fi
fi
