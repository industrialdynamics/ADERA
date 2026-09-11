# ADERA operator gateway
FROM node:20-alpine

WORKDIR /app

# Install dependencies first for layer caching. `npm ci` installs the exact
# tree pinned in package-lock.json, so this image builds identically today and
# in six months — a plain `npm install` would silently drift transitive deps.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error

# Application sources.
COPY gateway.js ./gateway.js
COPY lib ./lib

# Default OCPI port (overridden per-service by OCPI_PORT env + compose mapping).
EXPOSE 9101

CMD ["node", "gateway.js"]
