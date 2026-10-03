FROM node:24-bookworm-slim
ENV NODE_ENV=production X402M_RESPONDER_ENABLED=0 X402M_STORAGE_DIR=/data PORT=8080
WORKDIR /app
# Build context: x402m-bot. No wallets, npm tree or unrelated app sources.
COPY bot.mjs client.mjs ./
COPY hosted/server.mjs hosted/state.mjs ./hosted/
RUN mkdir -p /data && chmod 700 /data
EXPOSE 8080
CMD ["node", "hosted/server.mjs"]
