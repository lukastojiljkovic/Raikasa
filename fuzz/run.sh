#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Replays or fuzzes every target of the SharpFuzz harness with libfuzzer-dotnet.
#
#   run.sh replay <libfuzzer-dotnet> <harness.dll>   one pass over each target's committed corpus (-runs=0)
#   run.sh fuzz   <libfuzzer-dotnet> <harness.dll>   FUZZ_SECONDS (default 600) per target; the committed corpus is read,
#                                                    new inputs go into fuzz/work/<target> and crashes into fuzz/artifacts
#
# Run it from the repository root, after the harness is published and the library under test is instrumented
# (see .github/workflows/ci.yml, job fuzz-build). Every target runs even when one fails; the exit code is 1 when any did.
set -u

mode="${1:?mode: replay or fuzz}"
fuzzer="${2:?path of libfuzzer-dotnet}"
dll="${3:?path of the harness dll}"
seconds="${FUZZ_SECONDS:-600}"
targets=(dism sfc winget windows-update sidecar release version)

case "$mode" in
  replay) extra=(-runs=0) ;;
  fuzz) extra=(-max_total_time="$seconds" -timeout=10) ;;
  *) echo "mode must be replay or fuzz" >&2; exit 2 ;;
esac

mkdir -p fuzz/artifacts
failed=()
for target in "${targets[@]}"; do
  dir="fuzz/corpus/$target"
  mkdir -p "$dir"
  if [ -z "$(ls -A "$dir")" ]; then
    echo "::error::$dir holds no seed input"
    failed+=("$target")
    continue
  fi
  # libFuzzer writes new inputs into the first corpus folder, so a fuzz run keeps its own in fuzz/work and only reads the
  # committed one.
  corpus=("$dir")
  if [ "$mode" = fuzz ]; then
    mkdir -p "fuzz/work/$target"
    corpus=("fuzz/work/$target" "$dir")
  fi
  echo "::group::$target ($mode)"
  FUZZ_TARGET="$target" "$fuzzer" --target_path=dotnet --target_arg="$dll" "${extra[@]}" \
    -artifact_prefix="fuzz/artifacts/$target-" "${corpus[@]}" || failed+=("$target")
  echo "::endgroup::"
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "::error::failed fuzz targets: ${failed[*]}"
  exit 1
fi
echo "Every fuzz target passed ($mode)."
