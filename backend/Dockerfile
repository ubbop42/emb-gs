# Use a lightweight Node.js runtime environment
FROM node:20-slim

# Create and set the working directory
WORKDIR /app

# Copy only the server file into the container
COPY server.js .

# Expose port 8080 for incoming Fly.io traffic
EXPOSE 8080

# Define environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Run the server file directly using the Node.js binary
CMD ["node", "server.js"]