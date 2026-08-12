#!/usr/bin/env bash
set -euo pipefail

VERSION="0.14"
ARCHIVE_SHA256="62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275"
ARCHIVE_URL="https://github.com/LibreDWG/libredwg/releases/download/${VERSION}/libredwg-${VERSION}.tar.xz"
PREFIX="${1:-${HOME}/.cache/voxel-tools/libredwg-${VERSION}}"

if [[ -x "${PREFIX}/bin/dwg2dxf" ]]; then
  "${PREFIX}/bin/dwg2dxf" --version
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
archive="${work}/libredwg-${VERSION}.tar.xz"

curl --fail --location --retry 3 --retry-delay 2 --output "$archive" "$ARCHIVE_URL"
printf '%s  %s\n' "$ARCHIVE_SHA256" "$archive" | sha256sum --check --strict

tar -xJf "$archive" -C "$work"
pushd "${work}/libredwg-${VERSION}" >/dev/null

MAKEINFO=true ./configure \
  --prefix="$PREFIX" \
  --disable-bindings \
  --disable-shared

make -j"$(nproc)" MAKEINFO=true
make install MAKEINFO=true
popd >/dev/null

"${PREFIX}/bin/dwg2dxf" --version
