FROM dxflrs/garage:v2.4.1 AS garage-bin

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=garage-bin /garage /usr/local/bin/garage
RUN ln -s /usr/local/bin/garage /garage
COPY deploy/garage/garage.toml /etc/garage.toml
EXPOSE 3900 3901 3902 3903
ENTRYPOINT ["/garage", "server"]
