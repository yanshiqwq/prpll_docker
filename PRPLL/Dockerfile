FROM nvidia/cuda:12.8.0-runtime-ubuntu22.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/prpll
RUN wget -O prpll https://download.mersenne.ca/PRPLL-NTT/2026-04-25/prpll-ntt_linux-cuda_20260425 \
  && chmod +x prpll

# 健康检查：日志文件存在且 10 分钟内活跃，且最近无 Bye（进程未退出）
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
  CMD test -f /opt/prpll/data/gpuowl-0.log && [ $(( $(date +%s) - $(stat -c %Y /opt/prpll/data/gpuowl-0.log) )) -lt 600 ] && ! tail -n 5 /opt/prpll/data/gpuowl-0.log | grep -q 'Bye' || exit 1

ENTRYPOINT ["/opt/prpll/prpll"]