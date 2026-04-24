FROM ubuntu:22.04

RUN apt-get update && \
    apt-get install -y icecast2 gettext-base && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY icecast.xml.template /etc/icecast2/icecast.xml.template

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV ICECAST_SOURCE_PASSWORD=changeme
ENV ICECAST_RELAY_PASSWORD=changeme
ENV ICECAST_ADMIN_PASSWORD=changeme
ENV ICECAST_ADMIN_USER=admin
ENV ICECAST_PORT=8000
ENV ICECAST_MOUNT=/live
ENV ICECAST_MAX_LISTENERS=100
ENV ICECAST_HOSTNAME=localhost

EXPOSE ${ICECAST_PORT}

ENTRYPOINT ["/entrypoint.sh"]
