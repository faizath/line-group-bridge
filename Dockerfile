# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci

# Copy source code and build
COPY src/ src/
RUN npm run build

# Production runtime stage
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# Install ffmpeg for video previews and audio remuxing (FR-MSG-7/8)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080
ENV ADMIN_PORT=8081

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Create media directory for filesystem backend
RUN mkdir -p /app/data/media && chown -R node:node /app

USER node

EXPOSE 8080 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.ADMIN_PORT || 8081) + '/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
