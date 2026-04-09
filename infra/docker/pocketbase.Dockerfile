FROM alpine:3.20
ARG PB_VERSION=0.25.4
ARG TARGETARCH

RUN apk add --no-cache ca-certificates wget unzip \
    && wget -q "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip" -O /tmp/pb.zip \
    && unzip /tmp/pb.zip -d /usr/local/bin/ \
    && rm /tmp/pb.zip \
    && chmod +x /usr/local/bin/pocketbase

WORKDIR /pb
VOLUME /pb/pb_data

# Include schema migrations and hooks — applied automatically on startup
COPY infra/pocketbase/pb_migrations /pb/pb_migrations
COPY infra/pocketbase/pb_hooks /pb/pb_hooks

EXPOSE 8090
CMD ["pocketbase", "serve", "--http=0.0.0.0:8090"]
