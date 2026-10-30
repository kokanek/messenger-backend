# syntax=docker/dockerfile:1
# Build context: code/backend. Targets: dev (local, hot reload) and prod (CI and the VM).

FROM node:24-alpine AS base
WORKDIR /app

# Dependencies for this service and the shared package only.
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/message-service/package.json services/message-service/
RUN npm ci -w packages/shared -w services/message-service

FROM deps AS dev
# Load @messenger/shared from its TypeScript source, so hot reload covers it too.
ENV NODE_OPTIONS=--conditions=development
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY services/message-service services/message-service
CMD ["npm", "run", "dev", "-w", "services/message-service"]

FROM dev AS build
ENV NODE_OPTIONS=
RUN npm run build -w packages/shared -w services/message-service

FROM base AS prod
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/message-service/package.json services/message-service/
RUN npm ci -w packages/shared -w services/message-service --omit=dev && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/message-service/dist services/message-service/dist
COPY services/message-service/migrations services/message-service/migrations
USER node
CMD ["node", "services/message-service/dist/index.js"]
