# IllumAI v5 — container
# Zero-dependency Node app. Builds and runs anywhere (Docker, Render, Railway, VPS).
FROM node:20-slim

WORKDIR /app
# Only static files + the server — no npm install needed.
COPY package.json server.js index.html ./

# Persistent volume for accounts / sessions / usage / logs.
ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME /data

ENV NODE_ENV=production PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]