# Why this exists: deploying a Playwright-based scraper to Render's normal
# Node environment fails, because Playwright's "install --with-deps" step
# needs root/sudo to install OS-level libraries Chromium depends on, and
# Render's standard Node build runs as a non-root user with no sudo access
# (see the "su: Authentication failure" error that showed up trying the
# plain Node environment first).
#
# The fix: use Microsoft's own Playwright Docker image as the base. It
# already has Chromium AND all its system dependencies pre-installed at
# image-build time (as root, inside Microsoft's own build - not ours), so
# our build here never needs to install OS packages itself at all.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

# Copy just the manifest files first so Docker can cache the npm install
# layer - it only re-runs if package.json/package-lock.json actually change,
# not on every code edit.
COPY package*.json ./
RUN npm install

# Now copy the rest of the app.
COPY . .

# Render sets PORT itself at runtime - server.js already reads
# process.env.PORT, nothing else needed here.
CMD ["npm", "start"]
