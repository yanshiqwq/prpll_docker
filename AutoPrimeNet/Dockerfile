FROM python:3.12-alpine

RUN apk add --no-cache git \
 && git clone --depth 1 https://github.com/tdulcet/AutoPrimeNet.git /opt/autoprimenet \
 && apk del git \
 && rm -rf /var/cache/apk/* \
 && pip install --no-cache-dir requests

# 健康检查：日志存在且 2 小时内活跃，且主进程（PID 1）存活
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
  CMD test -e /opt/autoprimenet/data/autoprimenet.log && [ $(( $(date +%s) - $(stat -c %Y /opt/autoprimenet/data/autoprimenet.log) )) -lt 7200 ] && kill -0 1 || exit 1

ENTRYPOINT ["python", "-OO", "/opt/autoprimenet/autoprimenet.py"]