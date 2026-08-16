FROM docker.io/oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

RUN bun run build && chown -R bun:bun /app/dist /app/index.css

ENV PORT=8080
ENV NODE_ENV=production
ENV BACKEND_URL=http://backend:8000
EXPOSE 8080

USER bun
CMD ["bun", "run", "server.ts"]
