# Game server image. Build from the REPO ROOT so the sibling TS packages
# (protocol, engine) that game-server imports by relative path are available:
#
#   docker build -f packages/game-server/Dockerfile -t awale-server .
#   docker run -p 8080:8080 --env-file packages/game-server/.env awale-server
#
# Deps are installed at /app/packages so they resolve from the relatively
# imported protocol/engine sources too (no workspace hoisting required).

FROM node:22-slim
WORKDIR /app/packages

# install game-server deps (incl. viem, socket.io, tsx) hoisted one level up
COPY packages/game-server/package.json packages/game-server/package-lock.json ./
RUN npm ci

# sources: game-server/src imports ../../protocol/src and ../../engine/src
COPY packages/protocol/src ./protocol/src
COPY packages/engine/src ./engine/src
COPY packages/game-server/tsconfig.json ./game-server/
COPY packages/game-server/src ./game-server/src

WORKDIR /app/packages/game-server
ENV PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "src/main.ts"]
