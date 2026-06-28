# Single image: build the frontend with Vite, then serve it (+ 3 API endpoints)
# from the Bun backend on one port. Mount the Documents dir at runtime via DOCS_DIR.

FROM oven/bun:1.2 AS build
WORKDIR /app

# install + build frontend
COPY web/package.json web/
RUN cd web && bun install
COPY web/ web/
RUN cd web && bun run build

# server deps
COPY package.json .
RUN bun install

FROM oven/bun:1.2 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DOCS_DIR=/docs
ENV INK_DIR=/ink
ENV WEB_DIR=/app/web/dist

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web/dist ./web/dist
COPY server ./server
COPY package.json .

# /docs = read-only Document source (bind-mount :ro). /ink = writable sidecar store.
VOLUME ["/docs", "/ink"]
EXPOSE 8080

CMD ["bun", "run", "server/index.ts"]
