# BridgeBox AI Workforce Intelligence — application image.
#
# Plain `next build` + `next start` image (next.config.ts does NOT set output:"standalone", and this
# Dockerfile deliberately does not require it). The same image serves three roles via the command:
#   web     : npm run start            (Next.js on :3000)
#   worker  : npm run worker           (job queue poller, scripts/worker.ts via tsx)
#   migrate : npm run db:migrate       (drizzle migrations + drizzle/rls.sql)
# tsx and dotenv are devDependencies, and the worker/migrate scripts need them, so the runtime stage keeps
# the full node_modules. Trade-off: a larger image (~600 MB) in exchange for one image and zero code changes.
# See docs/DEPLOYMENT.md §B.

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Pages are dynamic (auth + RLS), so no database is contacted during `next build`; postgres.js connects lazily.
# The placeholders only keep module-load checks quiet. Real values are injected at runtime (env_file).
ENV AUTH_SECRET=build-time-placeholder \
    DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN apk add --no-cache libc6-compat curl && addgroup -S app && adduser -S app -G app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json package-lock.json next.config.ts tsconfig.json drizzle.config.ts postcss.config.mjs ./
COPY src ./src
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY docs ./docs
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://localhost:3000/login >/dev/null || exit 1
CMD ["npm", "run", "start"]
