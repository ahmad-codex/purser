#!/bin/sh
# Runs forge, cast or anvil from the official Foundry image when they are not installed locally.
# Usage, from the contracts directory: ./forge.sh forge build | ./forge.sh cast <args>
DIR="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
TOOL="$1"
shift
MSYS_NO_PATHCONV=1 exec docker run --rm -i --user root -v "$DIR:/work" -v purser-svm:/root/.svm -w /work \
  --network host --entrypoint "$TOOL" ghcr.io/foundry-rs/foundry:v1.8.1 "$@"
