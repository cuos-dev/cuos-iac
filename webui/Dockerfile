# SPDX-License-Identifier: Apache-2.0
FROM node:26.10.0-alpine3.24 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src/ src/
RUN npm run build

FROM node:26.10.0-alpine3.24
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY app.js ./
EXPOSE 3000
CMD ["node", "app.js"]
