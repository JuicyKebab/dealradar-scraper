FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Playwright browsers already included in the base image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
