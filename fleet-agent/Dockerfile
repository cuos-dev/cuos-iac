# SPDX-License-Identifier: Apache-2.0
FROM node:26.8.2-alpine3.24

WORKDIR /app
VOLUME ["/data"]
CMD ["npm","start"]

COPY package*.json ./
RUN npm install --omit=dev || npm install --omit=dev
COPY agent.js ./
