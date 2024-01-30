FROM node:18.17.0
WORKDIR /usr/src/app
COPY package.json ./
RUN npm install
# HEALTHCHECK --interval=12s --timeout=12s --start-period=30s \  
#   CMD node healthcheck.js
COPY . .
ENV NODE_ENV=production
CMD ["node", "index.js"]

