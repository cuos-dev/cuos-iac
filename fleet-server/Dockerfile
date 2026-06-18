FROM node:22-alpine AS build-ui
WORKDIR /app/webui
COPY webui/package*.json ./
RUN npm ci
COPY webui/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
VOLUME ["/data"]
EXPOSE 8085
ENV FLEET_SERVER_PORT=8085
COPY package*.json ./
RUN apk add --no-cache python3 make g++ && npm ci --omit=dev
COPY server.js ./
COPY --from=build-ui /app/webui/dist ./webui/dist
CMD ["node", "server.js"]
