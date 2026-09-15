#!/bin/sh
# Back-compat → docker/noite.sh with NOITE_MODE=dev
export NOITE_MODE=dev
exec /bin/sh /noite.sh
