FROM python:3.12-alpine

RUN apk add --no-cache git \
 && git clone --depth 1 https://github.com/tdulcet/AutoPrimeNet.git /opt/autoprimenet \
 && apk del git \
 && rm -rf /var/cache/apk/* \
 && pip install --no-cache-dir requests

ENTRYPOINT ["python", "-OO", "/opt/autoprimenet/autoprimenet.py"]