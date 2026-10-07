# API, worker, migrations and seed share one image; compose picks the command.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @fieldforms/api... --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @fieldforms/api run build \
 && pnpm --filter @fieldforms/api deploy --prod --legacy /out \
 && cp -r apps/api/dist apps/api/migrations /out/

FROM node:22-alpine
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /out /app
# A font, so text drawn into images (sample placeholders for test sends) renders.
RUN apk add --no-cache fontconfig font-dejavu
# Owned by node so a fresh named volume mounted here is writable.
RUN mkdir -p /data/blobs && chown node:node /data/blobs
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server.js"]
