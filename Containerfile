# snout-containers: runs OCI images under gVisor, from a manifest directory. See README.md.
#
#   docker build -f Containerfile -t snout-containers .
#
# The base is pinned by the digest of its multi-architecture index, so one pin covers amd64 and
# arm64. The image carries the RUNNER only: Node, our code, `podman-remote` to reach the engine's
# podman service and `systemctl` to set each container's slice. gVisor and that service are the
# host's (README.md, "The engine").
FROM docker.io/library/node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && rm -f dist/*.test.js

FROM docker.io/library/node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa
RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends podman-remote systemd ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY --from=build /src/dist ./dist
LABEL org.opencontainers.image.title="snout-containers" \
	org.opencontainers.image.description="Runs OCI images declared in a directory, each under gVisor, with limits, a network per project, restarts and logs." \
	org.opencontainers.image.licenses="Apache-2.0" \
	org.opencontainers.image.source="https://github.com/snoutdata/snout-containers" \
	com.snoutdata.stack="1" \
	com.snoutdata.component="containers"
# podman-remote reads its configuration from HOME, and the runner keeps nothing there.
ENV HOME=/tmp \
	CONTAINER_HOST=unix:///run/snoutct/podman.sock \
	SNOUT_CONTAINERS_MANIFESTS=/manifests \
	SNOUT_CONTAINERS_STATE=/state \
	PORT=8080
EXPOSE 8080
CMD ["node", "dist/main.js"]
