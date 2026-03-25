# Build stage
FROM node:20-slim

# Install system dependencies for Playwright Chromium
RUN apt-get update && apt-get install -y \
    libgconf-2-4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgdk-pixbuf2.0-0 \
    libgdk-pixbuf2.0-common \
    libgtk-3-0 \
    libgtk-3-common \
    libpango-1.0-0 \
    libpango-gobject-0 \
    libxss1 \
    libappindicator1 \
    libindicator7 \
    libnss3 \
    libgconf-2-4 \
    libnspr4 \
    libnss3 \
    fonts-liberation \
    libappindicator3-1 \
    libxss1 \
    lsb-release \
    xdg-utils \
    wget \
    ca-certificates \
    fonts-noto \
    fonts-noto-cjk \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm ci --only=production && npx playwright install chromium

# Copy application code
COPY index.js ./
COPY public ./public

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start application
CMD ["node", "index.js"]
