# SPDX-License-Identifier: Apache-2.0
FROM node:26.9.0-alpine3.24

WORKDIR /app
VOLUME ["/data"]
EXPOSE 8085
ENV FLEET_SERVER_PORT=8085
CMD ["npm","start"]

COPY package*.json ./
RUN npm install --omit=dev || npm install --omit=dev

COPY server.js ./
