# ADERA contract deployer
# Build context is ./contracts so this image can see both the deployer sources
# and the AderaRegistry.sol contract that sits one level up.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first for layer caching. `npm ci` installs the exact
# tree pinned in package-lock.json, so this image builds identically today and
# in six months — a plain `npm install` would silently drift transitive deps.
COPY deployer/package.json deployer/package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error

# Application sources.
COPY deployer/deploy.js ./deploy.js
COPY AderaRegistry.sol ./AderaRegistry.sol

CMD ["node", "deploy.js"]
