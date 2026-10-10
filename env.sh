#!/usr/bin/env bash
# Usage: source ./env.sh
rtlarch_project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$rtlarch_project_dir/bin:$rtlarch_project_dir/.runtime/bin:$PATH"
unset rtlarch_project_dir
