# Multi-stage Dockerfile for Neptune-AI Backend Engine
# Pinned to Node.js 20.18.1 (Active LTS "Iron" on Alpine Linux)
# Rationale: Node.js 20 is an active Long Term Support (LTS) release supported
# through 2026. The 20.18.1-alpine base provides security patch stability with
# a minimal footprint (~50MB base), reducing host memory consumption.

FROM node:20.18.1-alpine AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:20.18.1-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Install ffmpeg for browser audio format detection, decoding and resampling (e.g. WebM/Opus, MP4/AAC -> 16kHz PCM)
RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Create runtime directories for SQLite and configurations
RUN mkdir -p /app/data /app/config && chown -R node:node /app

USER node
EXPOSE 3000

CMD ["node", "dist/index.js"]
