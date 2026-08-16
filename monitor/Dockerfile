FROM node:24-alpine

RUN apk add --no-cache tzdata

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

COPY --chown=node:node package.json server.js db.js gpuowl-parse.js mersenne.js tasks.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node vendor ./vendor

RUN mkdir -p /data && chown node:node /data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "server.js"]
