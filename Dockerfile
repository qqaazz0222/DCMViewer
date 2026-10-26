# Web platform image: builds the viewer and server bundle, then ships only the runtime files.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Electron is a dev dependency of the desktop app; the platform build never runs it.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web

FROM node:22-bookworm-slim
WORKDIR /app/platform
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_ROOT=/data STATE_DIR=/state
COPY --from=build /app/platform/out ./out
COPY --from=build /app/platform/dist ./dist
COPY platform/login.html platform/admin.html platform/pages.css platform/pages-theme.js platform/generate-samples.cjs ./
COPY platform/assets ./assets
# Registration runs this script with Python and packages that install into /state on first use.
COPY scripts/register.py /app/scripts/register.py
RUN mkdir -p /data /state && chown node:node /data /state
USER node
VOLUME ["/data", "/state"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/auth-config').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "out/server.cjs"]
