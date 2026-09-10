ARG NODEJS_IMAGE=node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a
# x/crypto v0.56.0 (the patched release for the SSH DoS advisories) requires
# Go 1.26.  Keep the builder digest-pinned and multi-architecture.
ARG GOLANG_IMAGE=golang:1.26-bookworm@sha256:9fdc884aacc3bec89b20ffc69f4bb369c78210e3e4f600387b5128b12c199f81
# Node/Prisma dependencies contain architecture-specific binaries.  Build this
# stage for TARGETPLATFORM so the same Dockerfile produces a native arm64 image.
FROM $NODEJS_IMAGE AS base
RUN apk upgrade --no-cache

# Install dependencies only when needed
FROM base AS deps

WORKDIR /app

# Install Prisma Client - remove if not using Prisma
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
COPY prisma ./
# Install dependencies based on the preferred package manager
RUN \
    if [ -f yarn.lock ]; then yarn --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    elif [ -f pnpm-lock.yaml ]; then yarn global add pnpm && pnpm i --frozen-lockfile; \
    else echo "Lockfile not found." && exit 1; \
    fi


# Rebuild the source code only when needed
FROM base AS builder

ARG NEXT_PUBLIC_APP_VERSION

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN NEXTAUTH_URL=https://127.0.0.1:3443 \
    NEXTAUTH_SECRET=build-only-not-used-at-runtime-000000000000000000000000 \
    NEXT_TELEMETRY_DISABLED=1 SKIP_ENV_VALIDATION=1 npm run build \
    && ./node_modules/.bin/esbuild prisma/seed.ts --bundle --platform=node \
       --format=cjs --packages=external --outfile=prisma/seed.cjs

# Build ztmkworld from reviewed source. Do not ship the upstream repository's
# prebuilt binaries as part of the trusted supply chain.
FROM --platform=$BUILDPLATFORM $GOLANG_IMAGE AS ztmkworld_builder
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY ztnodeid/go.mod ztnodeid/go.sum ./
RUN go mod download
COPY ztnodeid/cmd ./cmd
COPY ztnodeid/pkg ./pkg
RUN CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
    go build -trimpath -ldflags='-s -w' -o /usr/local/bin/ztmkworld ./cmd/mkworld

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ARG NEXT_PUBLIC_APP_VERSION
ENV NEXT_PUBLIC_APP_VERSION=${NEXT_PUBLIC_APP_VERSION}

ENV NODE_ENV=production

# Disable telemetry during runtime.
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -S -g 1001 nodejs && adduser -S -D -H -u 1001 -G nodejs nextjs
COPY package.json package-lock.json ./
COPY prisma ./prisma
# Runtime migration and seed tooling is installed from the reviewed lockfile.
RUN npm ci --omit=dev && npm cache clean --force
# The entrypoint invokes the reviewed local Prisma binary directly. npm/npx are
# build-time package managers and are removed from the public runtime image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN mkdir -p /var/lib/zerotier-one && chown -R nextjs:nodejs /var/lib/zerotier-one && chmod -R 0750 /var/lib/zerotier-one
RUN mkdir -p /app/tmp/backups && chown -R nextjs:nodejs /app/tmp && chmod -R 0750 /app/tmp

COPY --from=builder /app/next.config.mjs ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/LICENSE ./LICENSE

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/init-db.sh ./init-db.sh
COPY --from=ztmkworld_builder /usr/local/bin/ztmkworld /usr/local/bin/ztmkworld

RUN chmod u+x init-db.sh

USER nextjs

EXPOSE 3000

ENV PORT=3000

ENTRYPOINT ["/app/init-db.sh"]
CMD ["node", "server.js"]
