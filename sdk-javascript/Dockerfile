# Development image for the tradesmart JavaScript SDK: test, lint, type-check and build tooling.
# Used through compose.yaml, which mounts the repository over /repo at run time, so code changes
# need no rebuild. Dependencies live in a per-service named volume (never in the mounted tree).
ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-slim

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# Tests read shared vectors from ../specifications, so the SDK lives one level below /repo.
WORKDIR /repo/sdk-javascript

CMD ["npm","test"]
