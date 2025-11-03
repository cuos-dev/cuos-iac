FROM node:24-alpine
WORKDIR /app
VOLUME [ "/data" ]
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install --omit=dev
COPY agent.js ./
CMD ["npm","start"]
