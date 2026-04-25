# Multi-stage build for production
FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc

# --- Production ---
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
COPY src/db/migrations/ dist/db/migrations/

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
