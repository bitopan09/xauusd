FROM node:20-alpine

RUN apk add --no-cache python3 make g++ build-base

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY frontend/package*.json frontend/
RUN cd frontend && npm install

COPY . .
RUN cd frontend && npm run build

ENV NODE_ENV=production

# Railway dynamically injects PORT — EXPOSE is informational only
EXPOSE ${PORT:-5002}

CMD ["node", "backend/server.js"]
