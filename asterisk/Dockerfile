FROM alpine:3.20

RUN apk add --no-cache \
    asterisk \
    asterisk-sample-config \
    asterisk-sounds-en \
    sox \
    python3 \
    py3-pip \
    curl \
    bash

# Fix directory ownership
RUN chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk

EXPOSE 5060/udp 10000-10050/udp

USER asterisk
CMD ["asterisk", "-f", "-vvv"]
