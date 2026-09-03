# Durable authenticated room server image.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/upstash-client ./packages/upstash-client
COPY packages/room-persistence ./packages/room-persistence
COPY apps/room-server ./apps/room-server
RUN npm ci --include-workspace-root -w packages/shared -w packages/upstash-client -w packages/room-persistence -w apps/room-server \
 && npm run build -w packages/shared -w packages/upstash-client -w packages/room-persistence -w apps/room-server
ENV NODE_ENV=production
CMD ["node", "apps/room-server/dist/index.js"]
