# Image tag must match the playwright version in package-lock.json
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV HEADLESS=1
CMD ["node", "track.js"]
