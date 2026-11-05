# GoldTerm site, static files only (no bot, no personal data).
# Build with docker/build-v1.sh, which exports the 5 site files from a release tag (default v1.1.1).
FROM nginxinc/nginx-unprivileged:1.28-alpine
ARG GOLDTERM_VERSION=1.1.1
LABEL org.opencontainers.image.title="goldterm-site" \
      org.opencontainers.image.version="${GOLDTERM_VERSION}"
# Rendered to /etc/nginx/conf.d/default.conf at start (only ${GOLDTERM_TRADES_UPSTREAM} is substituted).
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV GOLDTERM_TRADES_UPSTREAM=http://3.107.25.107 \
    NGINX_ENVSUBST_FILTER=^GOLDTERM_
USER root
RUN rm -f /usr/share/nginx/html/*
USER 101
COPY --chown=root:root --chmod=644 site/ /usr/share/nginx/html/
# Runs as the non-root "nginx" user (uid 101) on port 8080.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
