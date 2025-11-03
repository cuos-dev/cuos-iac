FROM node:24-alpine

WORKDIR /app
VOLUME ["/data"]
EXPOSE 8085
ENV FLEET_SERVER_PORT=8085
CMD ["npm","start"]

COPY package*.json ./
RUN npm install --omit=dev || npm install --omit=dev

COPY server.js ./
