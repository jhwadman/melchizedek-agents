# syntax=docker/dockerfile:1
# ── Melchizedek A2A server ───────────────────────────────────────────────────
# Builds the compiled server from this repository and runs it as a non-root
# user. Configuration is environment only (see .env.example); syndicates are
# read from /app/config/agents, so mount or COPY your own over it.
#
#   docker build -t melchizedek .
#   docker run --rm -p 4000:4000 --env-file .env \
#     -e HOST=0.0.0.0 melchizedek tutor.yaml
#
# A server bound to 0.0.0.0 needs A2A_SERVER_SECRET (or, knowingly,
# ALLOW_UNAUTHENTICATED=true) — the server refuses otherwise.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
# @google/adk is a peer dependency of the package (the consumer owns the ADK
# instance), so a production install of THIS repo has to add it explicitly,
# at the version the build was tested with.
RUN npm ci --omit=dev \
 && npm install --no-save --omit=dev "@google/adk@$(node -p "require('./package.json').devDependencies['@google/adk']")" \
 && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config ./config
COPY db ./db
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# SIGTERM drains running tasks (A2A_SHUTDOWN_GRACE_MS, default 25 s): give the
# orchestrator's stop timeout at least that long.
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "dist/scripts/a2a_server.js"]
CMD ["syndicate.yaml"]
