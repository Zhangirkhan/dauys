FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/pwa/package.json apps/pwa/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/mac-agent/package.json apps/mac-agent/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/pwa/package.json apps/pwa/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/mac-agent/package.json apps/mac-agent/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]
