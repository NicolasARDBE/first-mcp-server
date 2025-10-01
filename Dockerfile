# ---- Base stage (install deps for building) ----
FROM node:20-slim AS base

WORKDIR /usr/src/app

# Copy dependency files first (to leverage Docker cache)
COPY package*.json ./

# Install all dependencies (including devDeps for TypeScript build)
RUN npm ci

# ---- Build stage (compile TS -> JS) ----
FROM base AS build

# Copy the rest of the source code into the container
COPY . .

# Compile TypeScript -> dist/
RUN npm run build

# ---- Runtime stage (small final image) ----
FROM node:20-slim AS runtime

WORKDIR /usr/src/app

# Copy package.json and lockfile to install only production deps
COPY package*.json ./

# Install only production dependencies (no TypeScript, no devDeps)
RUN npm ci --omit=dev

# Copy compiled code from build stage
COPY --from=build /usr/src/app/build ./build

# (Optional) set environment variable for production
ENV NODE_ENV=production

# Expose MCP server port (adjust if your server uses another one)
EXPOSE 3000

# Run compiled JS (entrypoint is now dist/https-server.js)
CMD ["node", "build/https-server.js"]