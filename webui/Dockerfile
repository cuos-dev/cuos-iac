FROM node:25-alpine

WORKDIR /app
EXPOSE 3000
CMD ["node", "app.js"]

COPY package*.json ./
RUN npm install --omit=dev || npm install --omit=dev

COPY . .

