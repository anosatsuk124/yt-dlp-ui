# syntax=docker/dockerfile:1.7

# --- builder ----------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# better-sqlite3 builds a native addon during install.
RUN apk add --no-cache python3 make g++ libc6-compat

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- runner -----------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Runtime libs for the native addon.
RUN apk add --no-cache libc6-compat

# Copy the entire installed node_modules so tsx and the compiled
# better_sqlite3.node are both present.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next         ./.next
COPY --from=builder /app/src           ./src
COPY --from=builder /app/server.ts     ./server.ts
COPY --from=builder /app/schema.sql    ./schema.sql
COPY --from=builder /app/package.json  ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs

EXPOSE 3000
CMD ["npm", "start"]
