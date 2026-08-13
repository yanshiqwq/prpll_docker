#!/usr/bin/env bash
# 主机模式启动监控面板（无需 Docker）
# 需要 Node.js >= 18
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${PORT:-8080}"
DATA_DIR="${DATA_DIR:-$(cd .. && pwd)/data}"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node，请先安装 Node.js >= 18" >&2
  exit 1
fi

echo "监控面板: http://localhost:${PORT}  数据目录: ${DATA_DIR}"
exec env PORT="$PORT" DATA_DIR="$DATA_DIR" node server.js
