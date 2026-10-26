# SPDX-License-Identifier: Apache-2.0
FROM node:22.23.3-alpine3.24

# CuOS's own files; the packages in the image carry their own licences.
LABEL org.opencontainers.image.licenses=Apache-2.0

WORKDIR /app
EXPOSE 3000
CMD ["node", "app.js"]

COPY webui/package*.json ./
RUN npm install --omit=dev || npm install --omit=dev

COPY LICENSE.txt NOTICE /usr/share/licenses/cuos/
COPY webui/ ./

