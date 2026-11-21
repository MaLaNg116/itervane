# Build context: repository root. Candidate image; VM deployment is a later gate.
FROM node:24.14.0-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.9.0 --ignore-scripts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/verification/package.json packages/verification/package.json
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY fixtures/standard-app/package.json fixtures/standard-app/package.json
RUN pnpm --filter @itervane/standard-app install --frozen-lockfile --ignore-scripts
COPY fixtures/standard-app fixtures/standard-app
RUN pnpm --filter @itervane/standard-app build
RUN pnpm --filter @itervane/standard-app deploy --prod --legacy /app

FROM node:24.14.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/index.mjs"]
