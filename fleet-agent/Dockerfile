# SPDX-License-Identifier: Apache-2.0
FROM node:25.9.0-alpine3.22

WORKDIR /app
VOLUME ["/data"]
CMD ["npm","start"]

COPY package*.json ./
RUN npm install --omit=dev || npm install --omit=dev
COPY agent.js ./
