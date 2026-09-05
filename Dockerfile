# syntax=docker/dockerfile:1.7
FROM rust:1.88.0-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0 AS builder

ARG ZEROTIER_VERSION=1.16.2
ARG ZEROTIER_COMMIT=fc5c3ec22090b5b2a0f274e863651fe9ca489bf4

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates clang cmake git make pkg-config protobuf-compiler protobuf-compiler-grpc \
       libgrpc++-dev libprotobuf-dev libpq-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build/ZeroTierOne
RUN git init . \
    && git remote add origin https://github.com/zerotier/ZeroTierOne.git \
    && git fetch --depth=1 origin "${ZEROTIER_COMMIT}" \
    && test "$(git rev-parse FETCH_HEAD)" = "${ZEROTIER_COMMIT}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(sed -n 's/^#define ZEROTIER_ONE_VERSION_MAJOR \([0-9]*\)$/\1/p' version.h).$(sed -n 's/^#define ZEROTIER_ONE_VERSION_MINOR \([0-9]*\)$/\1/p' version.h).$(sed -n 's/^#define ZEROTIER_ONE_VERSION_REVISION \([0-9]*\)$/\1/p' version.h)" = "${ZEROTIER_VERSION}"

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/ZeroTierOne/rustybits/target \
    CARGO_BUILD_JOBS=2 make -j4 ZT_CARGO_FLAGS="--locked --release" central-controller \
    && CARGO_BUILD_JOBS=2 make -j4 ZT_CARGO_FLAGS="--locked --release" ZT_OTEL=1 ZT_CONTROLLER=1 selftest \
    && otel_lib="$PWD/ext/opentelemetry-cpp-1.21.0/localinstall/lib" \
    && LD_LIBRARY_PATH="$otel_lib" ./zerotier-selftest \
    && strip zerotier-one \
    && install -d /build/licenses/zerotier \
    && cp LICENSE-MPL.txt /build/licenses/zerotier/ \
    && cp nonfree/LICENSE.md /build/licenses/zerotier/LICENSE-nonfree.md

RUN set -eu; \
    otel_lib="$PWD/ext/opentelemetry-cpp-1.21.0/localinstall/lib"; \
    install -D -m 0755 zerotier-one /build/runtime-root/usr/sbin/zerotier-one; \
    LD_LIBRARY_PATH="$otel_lib" ldd zerotier-one \
       | awk '$3 ~ /^\// { print $3 } $1 ~ /^\// { print $1 }' \
       | sort -u > /tmp/zt-runtime-libraries; \
    while IFS= read -r library; do \
      case "$library" in \
        "$otel_lib"/*) install -D -m 0755 "$library" "/build/runtime-root/usr/lib/$(basename "$library")" ;; \
        *) install -D -m 0755 "$library" "/build/runtime-root$library" ;; \
      esac; \
    done < /tmp/zt-runtime-libraries; \
    find /lib /usr/lib \( -name libnss_dns.so.2 -o -name libnss_files.so.2 \) -print \
       | while IFS= read -r library; do install -D -m 0755 "$library" "/build/runtime-root$library"; done; \
    install -D -m 0644 /etc/nsswitch.conf /build/runtime-root/etc/nsswitch.conf; \
    install -D -m 0644 /etc/os-release /build/runtime-root/etc/os-release; \
    install -D -m 0644 /etc/ssl/certs/ca-certificates.crt /build/runtime-root/etc/ssl/certs/ca-certificates.crt; \
    install -d -m 0755 /build/runtime-root/var/lib/dpkg; \
    { \
      { while IFS= read -r library; do \
          case "$library" in "$otel_lib"/*) continue ;; esac; \
          dpkg-query -S "$library" 2>/dev/null | sed -n '1s/:.*//p'; \
        done < /tmp/zt-runtime-libraries; echo ca-certificates; } | sort -u \
        | while IFS= read -r package; do \
            dpkg-query -W -f='Package: ${Package}\nStatus: install ok installed\nArchitecture: ${Architecture}\nVersion: ${Version}\n\n' "$package"; \
          done; \
    } > /build/runtime-root/var/lib/dpkg/status; \
    install -d -m 2770 -o root -g 1001 /build/runtime-root/var/lib/zerotier-one; \
    install -d -m 0755 /build/runtime-root/bin /build/runtime-root/usr/bin /build/runtime-root/usr/sbin; \
    for applet in sh mkdir chown chmod kill sleep find cat wget; do ln -s /bin/busybox "/build/runtime-root/bin/$applet"; done; \
    ln -s /bin/busybox /build/runtime-root/usr/bin/env; \
    ln -s zerotier-one /build/runtime-root/usr/sbin/zerotier-cli; \
    ln -s zerotier-one /build/runtime-root/usr/sbin/zerotier-idtool

FROM busybox:1.37.0-musl@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23 AS busybox

FROM scratch
COPY --from=busybox /bin/busybox /bin/busybox
COPY --from=builder /build/runtime-root/ /
COPY --from=builder /build/licenses/zerotier /usr/share/doc/zerotier
ENV LD_LIBRARY_PATH=/usr/lib
COPY --chmod=0755 services/zerotier/entrypoint.sh /usr/local/bin/ztplanet-entrypoint
VOLUME ["/var/lib/zerotier-one"]
EXPOSE 9993/tcp 9993/udp
ENTRYPOINT ["/usr/local/bin/ztplanet-entrypoint"]
