#!/usr/bin/env bash

source "$(dirname "${BASH_SOURCE[0]}")/_config.sh"
false && source _config.sh # never executes, this is here just for IntelliJ Bash support to understand our sourcing

pushd "$DEVSERVER_ROOT"

python -m SimpleHTTPServer "$DEVSERVER_PORT"

popd
