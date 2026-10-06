# SPDX-License-Identifier: Apache-2.0
FROM node:22.23.3-alpine3.24

WORKDIR /app
EXPOSE 3000
CMD ["node", "app.js"]

COPY package*.json ./
RUN npm install --omit=dev || npm install --omit=dev

COPY . .

