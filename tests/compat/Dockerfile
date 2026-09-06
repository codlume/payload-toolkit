ARG NODE_VERSION=24.13.1
FROM node:${NODE_VERSION}-bookworm-slim

ENV CI=1
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm install --global pnpm@10.34.5 && pnpm --version

WORKDIR /workspace

COPY tsconfig.base.json tsconfig.base.json
COPY apps/payload-cms apps/payload-cms
COPY packages/payload-activity packages/payload-activity
COPY packages/payload-blurhash packages/payload-blurhash
COPY packages/payload-live-preview packages/payload-live-preview
COPY tests/run-command.mjs tests/run-command.mjs
COPY tests/compat tests/compat

CMD ["node", "tests/compat/inside.mjs"]
