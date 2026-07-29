# Build the web app, then run the real Hono API (apps/api/src/server.ts)
# which serves both /api/* and the built web assets — one Fly app, one
# process.
#
# Fly Launch's generated Dockerfile was `FROM pierrezemb/gostatic` plus
# `COPY . /srv/http/`, which serves the whole build context — source, .git,
# and any untracked .env.local — as downloadable static files. This two-stage
# build ships only node_modules, the apps/api and packages/shared sources,
# and apps/web/dist to the runtime image — nothing else, no .git, no .env*.
#
# apps/api runs its TypeScript directly under Node's type stripping
# (its tsconfig sets `noEmit`), so there is no compiled apps/api output to
# copy — the runtime CMD below runs src/server.ts as-is.

FROM node:24-alpine AS build
WORKDIR /app

# Pin npm to the version that produced the committed package-lock.json.
# node:24-alpine currently bundles npm 11.16.0, which considers that lock
# file out of sync over transitive @emnapi optional-dependency versions and
# refuses `npm ci` outright with EUSAGE — confirmed by reproducing the
# failure in this exact base image. npm 11.6.2 (this repo's dev-machine
# version) accepts the same lock file with no changes. Pin rather than
# regenerate the lock file so `npm ci`'s reproducibility guarantee holds
# regardless of which npm a future base-image bump happens to bundle.
RUN npm install -g npm@11.6.2

# Workspace manifests first, so a source-only change below reuses this
# `npm ci` layer instead of reinstalling every dependency.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN npm ci

COPY . .

# No build arg for the Mapbox token, deliberately.
#
# It used to be inlined into the client bundle by Vite here, which meant it
# had to exist twice — as a build argument AND a runtime secret — and made a
# GitHub-triggered deploy impossible without committing it, since such a build
# never sees `--build-arg`. GitHub's push protection then refused that commit,
# unable to distinguish a public `pk.` token from a secret `sk.` one.
#
# The client now fetches it from `GET /api/config` at runtime, so the token
# lives only in `fly secrets` and never in git or in image layer history.
# `fly secrets set VITE_MAPBOX_TOKEN=...` is still required — the API's own
# routing stage reads it server-side at startup and the container will not
# boot without it.
RUN npm run build --workspace @ai-guide/web

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Same relative layout as the build stage (/app/node_modules,
# /app/packages/shared, /app/apps/api) so the npm-workspace symlink at
# node_modules/@ai-guide/shared -> ../../packages/shared still resolves.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist

# apps/api/src/server.ts explicitly binds 0.0.0.0. Node's own "no hostname
# given" default already listens on all interfaces, but binding to
# localhost inside a container is the classic trap here: the process looks
# perfectly healthy in `fly logs` and is unreachable from outside, so this
# is spelled out rather than relied on implicitly.
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
