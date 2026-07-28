# Build the web app, then serve only its built output.
#
# Fly Launch's generated Dockerfile was `FROM pierrezemb/gostatic` plus
# `COPY . /srv/http/`, which serves the whole build context — source, .git,
# and any untracked .env.local — as downloadable static files. This replaces
# it with a two-stage build that ships nothing but apps/web/dist.
#
# Task 12 of the generation-pipeline plan replaces this again, with the Hono
# API serving both the JSON endpoints and these assets. Until the API does
# more than answer /api/health, static is what there is to deploy.

FROM node:24-alpine AS build
WORKDIR /app

# Workspace manifests first, so a dependency-only change reuses this layer.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN npm ci

COPY . .
RUN npm run build --workspace @ai-guide/web

FROM pierrezemb/gostatic
COPY --from=build /app/apps/web/dist /srv/http/
CMD ["-port", "8080", "-https-promote", "-enable-logging"]
