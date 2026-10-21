FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY dist/server ./dist/server
COPY drizzle ./drizzle
COPY scripts ./scripts
ENV HOST=0.0.0.0 PORT=4178 DATA_FILE=/data/learning.sqlite
VOLUME /data
EXPOSE 4178
CMD ["node", "scripts/serve.mjs"]
