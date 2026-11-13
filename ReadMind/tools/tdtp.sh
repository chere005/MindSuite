#!/bin/sh
# tdtp — test, deploy, tag, push. See tools/dtp.sh for the lane.
exec sh "$(dirname "$0")/dtp.sh" --full "$@"
