#!/bin/bash
set -e

envsubst < /etc/icecast2/icecast.xml.template > /etc/icecast2/icecast.xml

chown icecast2:icecast /etc/icecast2/icecast.xml

exec icecast2 -c /etc/icecast2/icecast.xml
