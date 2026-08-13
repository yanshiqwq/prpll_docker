FROM node:20-alpine

# 时区数据：日志与界面时间按 Asia/Shanghai 展示
RUN apk add --no-cache tzdata

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

COPY --chown=node:node package.json server.js mersenne.js tasks.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node vendor ./vendor

RUN mkdir -p /data && chown node:node /data

EXPOSE 8080

# 健康检查：确保 API 可响应（数据目录未挂载时也能返回状态）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "server.js"]
