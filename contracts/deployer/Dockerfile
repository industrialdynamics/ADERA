# ADERA contract deployer
# Build context is ./contracts so this image can see both the deployer sources
# and the AderaRegistry.sol contract that sits one level up.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first for layer caching.
COPY deployer/package.json ./package.json
RUN npm install --no-audit --no-fund --loglevel=error

# Application sources.
COPY deployer/deploy.js ./deploy.js
COPY AderaRegistry.sol ./AderaRegistry.sol

CMD ["node", "deploy.js"]
