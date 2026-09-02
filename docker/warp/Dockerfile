FROM debian:12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl iproute2 libcap2-bin libdbus-1-3 libnss3-tools libpcap0.8 \
      libtss2-esys-3.0.2-0 libtss2-tctildr0 nftables \
    && architecture="$(dpkg --print-architecture)" \
    && package_path="$(curl -fsSL "https://pkg.cloudflareclient.com/dists/bookworm/main/binary-${architecture}/Packages" \
      | awk '/^Filename: / { print $2; exit }')" \
    && test -n "$package_path" \
    && curl -fsSL "https://pkg.cloudflareclient.com/${package_path}" -o /tmp/cloudflare-warp.deb \
    && mkdir -p /tmp/cloudflare-warp-root \
    && dpkg-deb --extract /tmp/cloudflare-warp.deb /tmp/cloudflare-warp-root \
    && install -m 0755 /tmp/cloudflare-warp-root/bin/warp-svc /usr/local/bin/warp-svc \
    && install -m 0755 /tmp/cloudflare-warp-root/bin/warp-cli /usr/local/bin/warp-cli \
    && rm -rf /tmp/cloudflare-warp.deb /tmp/cloudflare-warp-root \
    && ! ldd /usr/local/bin/warp-svc /usr/local/bin/warp-cli | grep -q "not found" \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/warp-entrypoint
COPY healthcheck.sh /usr/local/bin/warp-healthcheck
RUN chmod 0755 /usr/local/bin/warp-entrypoint /usr/local/bin/warp-healthcheck

ENTRYPOINT ["/usr/local/bin/warp-entrypoint"]
