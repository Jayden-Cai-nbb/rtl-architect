#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"
export PATH="$project_dir/.runtime/bin:$PATH"
if [[ ! -x .runtime/bin/node || ! -f node_modules/tsx/package.json || ! -f dist/index.html ]]; then
  echo 'Demo 环境不完整，请按 README 恢复运行环境、npm ci 并 npm run build。' >&2
  exit 1
fi
exec node --import tsx scripts/start-demo.ts
