FROM rust:1.85.1-alpine3.21@sha256:4333721398de61f53ccbe53b0b855bcc4bb49e55828e8f652d7a8ac33dd0c118 AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --locked --release

FROM scratch
COPY --from=builder /src/target/release/ztplanet-relay /usr/local/bin/ztplanet-relay
COPY LICENSE /usr/share/doc/ztplanet-relay/LICENSE
USER 65532:65532
EXPOSE 4443/tcp 9090/tcp
ENTRYPOINT ["/usr/local/bin/ztplanet-relay"]
