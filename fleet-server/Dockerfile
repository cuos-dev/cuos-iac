# SPDX-License-Identifier: Apache-2.0
FROM node:22.23.3-alpine3.24

# CuOS's own files; the packages in the image carry their own licences.
LABEL org.opencontainers.image.licenses=Apache-2.0

WORKDIR /app
VOLUME ["/data"]
EXPOSE 8085
ENV FLEET_SERVER_PORT=8085
CMD ["npm","start"]

COPY fleet-server/package*.json ./
RUN npm install --omit=dev || npm install --omit=dev

COPY LICENSE.txt NOTICE /usr/share/licenses/cuos/
COPY fleet-server/server.js ./
