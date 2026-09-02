# Railway live-room test image: fork room server + hosted agent in one process.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/local-server ./apps/local-server
COPY apps/hosted-agent ./apps/hosted-agent
COPY scripts/bootstrap-local.mjs ./scripts/bootstrap-local.mjs
RUN npm ci --include-workspace-root -w packages/shared -w apps/local-server -w apps/hosted-agent \
 && npm run build -w packages/shared -w apps/local-server -w apps/hosted-agent
ENV NODE_ENV=production
CMD ["node", "apps/hosted-agent/dist/index.js"]
