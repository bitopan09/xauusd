FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY frontend/package*.json frontend/
RUN cd frontend && npm install

COPY . .
RUN cd frontend && npm run build

ENV PORT=5002
ENV NODE_ENV=production

EXPOSE 5002

CMD ["node", "backend/server.js"]
