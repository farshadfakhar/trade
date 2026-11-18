FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build -w web && cd server && npx prisma generate

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV HOST=0.0.0.0
WORKDIR /app/server
# shortcut: `db push` instead of migrations, and dev deps (tsx, prisma CLI) stay in the image; fine for one small bot.
CMD ["sh", "-c", "npx prisma db push --skip-generate && node --import tsx src/main.ts"]
