# ADERA operator gateway
FROM node:20-alpine

WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json ./package.json
RUN npm install --no-audit --no-fund --loglevel=error

# Application sources.
COPY gateway.js ./gateway.js
COPY lib ./lib

# Default OCPI port (overridden per-service by OCPI_PORT env + compose mapping).
EXPOSE 9101

CMD ["node", "gateway.js"]
