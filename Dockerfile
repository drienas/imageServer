FROM node:latest
WORKDIR /usr/src/app
COPY package.json ./
RUN npm install
HEALTHCHECK --interval=12s --timeout=12s --start-period=30s \  
  CMD node healthcheck.js
COPY . .
CMD ["node", "index.js"]

