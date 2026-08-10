#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ ! -f data/prime.ini ]]; then
    echo "检测到首次启动"
    mkdir -p data
    docker compose build
    docker compose run --rm autoprimenet --setup --prpll -w /opt/autoprimenet/data/ -l prime.ini
    echo "配置文件已生成，再次运行即可启动服务"
else
	echo "配置文件已存在"
    docker compose up -d
fi
