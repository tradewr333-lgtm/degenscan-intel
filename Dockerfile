FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm i -g tsx
COPY . .
ENV PORT=8787 DB_PATH=/data/intel.db UNIVERSE_PATH=/data/universe.json
VOLUME /data
EXPOSE 8787
CMD ["tsx", "src/cli.ts", "serve"]
