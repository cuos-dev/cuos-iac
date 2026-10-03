# SPDX-License-Identifier: Apache-2.0
FROM node:26.10.0-alpine3.24 AS build-ui
WORKDIR /app/webui
COPY webui/package*.json ./
RUN npm ci
COPY webui/ ./
RUN npm run build

FROM node:26.10.0-alpine3.24
WORKDIR /app
VOLUME ["/data"]
EXPOSE 8085
ENV FLEET_SERVER_PORT=8085
COPY package*.json ./
RUN apk add --no-cache python3 make g++ && npm ci --omit=dev
COPY server.js store.js ./
COPY --from=build-ui /app/webui/dist ./webui/dist
CMD ["node", "server.js"]
