# syntax=docker/dockerfile:1
# Build context: code/backend. Targets: dev (local, hot reload) and prod (CI and the VM).

FROM node:24-alpine AS base
WORKDIR /app

# Dependencies for this service and the shared package only.
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/auth-service/package.json services/auth-service/
RUN npm ci -w packages/shared -w services/auth-service

FROM deps AS dev
# Load @messenger/shared from its TypeScript source, so hot reload covers it too.
ENV NODE_OPTIONS=--conditions=development
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY services/auth-service services/auth-service
CMD ["npm", "run", "dev", "-w", "services/auth-service"]

FROM dev AS build
ENV NODE_OPTIONS=
RUN npm run build -w packages/shared -w services/auth-service

FROM base AS prod
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/auth-service/package.json services/auth-service/
RUN npm ci -w packages/shared -w services/auth-service --omit=dev && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/auth-service/dist services/auth-service/dist
COPY services/auth-service/migrations services/auth-service/migrations
USER node
CMD ["node", "services/auth-service/dist/index.js"]
