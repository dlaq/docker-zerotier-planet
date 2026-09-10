# Caddy's transitive x/crypto dependency is pinned below to the release that
# fixes the 2026 SSH DoS advisories; that release requires Go 1.26.
FROM golang:1.26.8-alpine3.23@sha256:33ce311e5eecedee48ec1b84419c1306e9fbd71009f0d5c3f2a6904b579c1ecc AS builder

ARG CADDY_VERSION=2.11.4
ARG CADDY_COMMIT=e2eee6a7fce366321294c9c2a79f3146891dcbdf

RUN apk add --no-cache git
WORKDIR /src/caddy
COPY caddy-cel-go-0.29.patch /tmp/caddy-cel-go-0.29.patch
RUN git init . \
    && git remote add origin https://github.com/caddyserver/caddy.git \
    && git fetch --depth=1 origin "refs/tags/v${CADDY_VERSION}:refs/tags/v${CADDY_VERSION}" \
    && test "$(git rev-list -n1 "v${CADDY_VERSION}")" = "${CADDY_COMMIT}" \
    && git fetch --depth=1 origin "${CADDY_COMMIT}" \
    && test "$(git rev-parse FETCH_HEAD)" = "${CADDY_COMMIT}" \
    && git checkout --detach FETCH_HEAD \
    && git apply --check /tmp/caddy-cel-go-0.29.patch \
    && git apply /tmp/caddy-cel-go-0.29.patch \
    && go get golang.org/x/crypto@v0.56.0 \
              golang.org/x/net@v0.57.0 \
              golang.org/x/text@v0.41.0 \
              github.com/google/cel-go@v0.29.0 \
              google.golang.org/grpc@v1.83.1 \
    && go mod tidy \
    && install -d /out \
    && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/caddy ./cmd/caddy \
    && /out/caddy version \
    && cp LICENSE /out/LICENSE

FROM scratch
COPY --from=builder /out/caddy /usr/bin/caddy
COPY --from=builder /out/LICENSE /usr/share/doc/caddy/LICENSE
USER 1002:1002
EXPOSE 80 443 443/udp 2019
ENTRYPOINT ["/usr/bin/caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
