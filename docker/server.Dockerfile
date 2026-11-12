# syntax=docker/dockerfile:1
FROM oven/bun:1.4-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
# Bun's isolated linker gives each workspace its own node_modules of symlinks
# into node_modules/.bun, so the whole tree is carried over below.
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4-slim
# poppler-utils: pdftotext/pdfinfo for PDF full text.
# No Chromium here: the browser fallback runs in its own container
# (`browser` in compose.yaml), away from the database and the keys.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app ./
COPY packages/shared/src packages/shared/src
COPY apps/server/src apps/server/src
WORKDIR /app/apps/server
USER bun
EXPOSE 8787
CMD ["bun", "src/main.ts"]
