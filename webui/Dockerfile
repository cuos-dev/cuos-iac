# SPDX-License-Identifier: Apache-2.0
FROM node:25.9.0-alpine3.22

WORKDIR /app
EXPOSE 3000
CMD ["node", "app.js"]

COPY package*.json ./
RUN npm install --omit=dev || npm install --omit=dev

COPY . .

