FROM node:24.13.1-bookworm-slim

ENV CI=true
WORKDIR /workspace

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json vite.config.ts ./
COPY apps/payload-cms/package.json apps/payload-cms/package.json
COPY packages/payload-blurhash/package.json packages/payload-blurhash/package.json

RUN corepack enable && corepack prepare pnpm@11.10.0 --activate \
  && pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm rebuild esbuild sharp

COPY apps/payload-cms/tests/fixtures/images apps/payload-cms/tests/fixtures/images
COPY packages/payload-blurhash packages/payload-blurhash
COPY tests/limits tests/limits

RUN pnpm --filter @codlume/payload-blurhash build

CMD ["node", "tests/limits/inside.mjs"]
