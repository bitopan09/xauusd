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
ENV CONFLUENCE_THRESHOLD=6.5
ENV TP1_CLOSE_PERCENT=60
ENV MAX_SL_DISTANCE=10
ENV SCORE_MARGIN_MIN=1
ENV BUY_SCORE_MARGIN=2
ENV EMA_ALIGNMENT_REQUIRED=false

EXPOSE ${PORT:-5002}

CMD ["node", "backend/server.js"]
