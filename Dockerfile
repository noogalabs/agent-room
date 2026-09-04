# Durable authenticated room server image.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/upstash-client ./packages/upstash-client
COPY packages/room-persistence ./packages/room-persistence
COPY apps/room-server ./apps/room-server
COPY apps/web ./apps/web
RUN npm ci --include-workspace-root -w packages/shared -w packages/upstash-client -w packages/room-persistence -w apps/room-server -w apps/web \
 && npm run build -w packages/shared -w packages/upstash-client -w packages/room-persistence -w apps/room-server -w apps/web
ENV NODE_ENV=production
CMD ["node", "apps/room-server/dist/index.js"]
