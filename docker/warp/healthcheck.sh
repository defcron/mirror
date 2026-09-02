#!/bin/sh
set -eu

warp-cli --accept-tos status 2>/dev/null | grep -Eq '(^|[[:space:]])Connected([[:space:]]|$)'
