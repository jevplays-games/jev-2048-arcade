FROM node:22-slim
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
EXPOSE 8787
VOLUME /data
CMD ["node", "server/local.js"]
