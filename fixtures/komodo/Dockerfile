FROM docker.io/library/busybox:1.37.0@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4
ARG FIXTURE_VERSION
RUN mkdir /www && printf '%s\n' "$FIXTURE_VERSION" > /www/healthz
USER 65534:65534
EXPOSE 8080
CMD ["/bin/busybox", "httpd", "-f", "-p", "8080", "-h", "/www"]
