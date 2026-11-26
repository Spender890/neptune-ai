FROM mikebrady/shairport-sync:latest

RUN apk add --no-cache jq alsa-plugins-pulse

COPY run.sh /usr/local/bin/ha-run.sh
RUN sed -i 's/\r$//' /usr/local/bin/ha-run.sh && chmod a+x /usr/local/bin/ha-run.sh

ENTRYPOINT ["/usr/local/bin/ha-run.sh"]
