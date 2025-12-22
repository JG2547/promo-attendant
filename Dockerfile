# Lightweight Node.js image for Promo Attendant
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source code
COPY . .

# Set environment variables
ENV NODE_ENV=production

# Expose port for health checks
EXPOSE 3000

# Run the service
CMD ["node", "index.js"]
