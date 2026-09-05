FROM postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73 AS patched

# Apply current Alpine security fixes. The upstream image's gosu binary was
# built with an obsolete Go standard library; su-exec provides the same
# user-switching contract needed by docker-entrypoint.sh without that runtime.
RUN apk upgrade --no-cache \
    && apk add --no-cache su-exec \
    && rm -f /usr/local/bin/gosu \
    && ln -s /sbin/su-exec /usr/local/bin/gosu

# Flatten the patched rootfs so scanners and downstream distributors do not
# retain the vulnerable, deleted gosu binary in an inaccessible parent layer.
FROM scratch
COPY --from=patched / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=en_US.utf8 \
    PG_MAJOR=17 \
    PG_VERSION=17.11 \
    PG_SHA256=dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979 \
    DOCKER_PG_LLVM_DEPS="llvm21-dev clang21" \
    PGDATA=/var/lib/postgresql/data
WORKDIR /
VOLUME ["/var/lib/postgresql/data"]
EXPOSE 5432
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["postgres"]
STOPSIGNAL SIGINT
