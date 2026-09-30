# Valora production image.
# better-sqlite3's install script is skipped (--ignore-scripts) and its
# prebuilt native binary is placed explicitly for reliability.
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# better-sqlite3 native binding (must match the pinned version in package.json;
# node:22 => ABI v127, Debian glibc => linux-x64)
RUN mkdir -p node_modules/better-sqlite3/build/Release \
  && curl -sL -o /tmp/bs.tar.gz https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-node-v127-linux-x64.tar.gz \
  && tar xzf /tmp/bs.tar.gz -C /tmp \
  && cp /tmp/build/Release/better_sqlite3.node node_modules/better-sqlite3/build/Release/ \
  && rm -rf /tmp/bs.tar.gz /tmp/build \
  && node -e "require('better-sqlite3'); console.log('better-sqlite3 binding OK')"

COPY . .

# Data directory (overridden by the Fly.io persistent volume at /data)
RUN mkdir -p /data/uploads

ENV PORT=8080 \
    NODE_ENV=production \
    DB_PATH=/data/valora.db \
    UPLOAD_DIR=/data/uploads

VOLUME /data
EXPOSE 8080

CMD ["node", "src/server.js"]
