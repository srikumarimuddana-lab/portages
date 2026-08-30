#!/usr/bin/env bash
#
# Scans the working tree for committed key material.
#
# Deliberately narrow. A scan that fires on every file mentioning the word
# "secret" gets muted within a week, and a muted scan catches nothing — so
# this looks only for values that are key material by construction, and it
# discards the two shapes that provably are not:
#
#   1. AWS's own documented example identifiers. AWS suffixes every
#      credential in its docs and SigV4 test vectors with EXAMPLE, and those
#      vectors are what you check a signer against. AKIAIOSFODNN7EXAMPLE is
#      in the published SigV4 test suite; it is not a credential.
#
#   2. PEM blocks whose body is elided. A setup guide has to show the shape
#      of a private key without containing one, so it prints the BEGIN line
#      followed by a truncated body. A real key's body is never truncated.
#
# Both exemptions are decided by the content of the match, not by the path
# it was found at — so a real key pasted into a docs page or a test file is
# still caught. That is the point: the mistake this defends against is
# someone pasting a working key into a file they thought was harmless.
#
# Usage:  scripts/scan-secrets.sh          # scans tracked files
# Exit:   0 clean, 1 something found.

set -uo pipefail

cd "$(dirname "$0")/.."

# Candidate matches, as path:line:text. -I skips binaries.
candidates=$(
  git grep -n -I -E \
    -e '\-\-\-\-\-BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY\-\-\-\-\-' \
    -e 'AKIA[0-9A-Z]{16}' \
    -e 'sk-ant-[A-Za-z0-9_-]{20,}' \
    -e 'gh[pousr]_[A-Za-z0-9]{36,}' \
    -e 'github_pat_[A-Za-z0-9_]{22,}' \
    -- . ':(exclude)*.example' ':(exclude)**/typecheck/**' \
    ':(exclude)scripts/scan-secrets.sh' \
    ':(exclude).github/workflows/*'
)

[ -z "$candidates" ] && { echo "No key material found."; exit 0; }

findings=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  file=${hit%%:*}
  rest=${hit#*:}
  lineno=${rest%%:*}
  text=${rest#*:}

  # (1) AWS documentation identifiers.
  case "$text" in *EXAMPLE*) continue;; esac

  # (2) A PEM header is only interesting if a real body follows it. Read the
  # next few lines: an elided placeholder carries "..." or reaches END with
  # almost nothing between. A real key does neither.
  case "$text" in
    *'BEGIN'*'PRIVATE KEY'*)
      body=$(sed -n "$((lineno + 1)),$((lineno + 4))p" "$file")
      case "$body" in
        *'...'*|*'…'*) continue;;
      esac
      # Fewer than 60 base64 characters before the END line is not a key.
      b64=$(printf '%s\n' "$body" | tr -cd 'A-Za-z0-9+/=' | wc -c)
      [ "$b64" -lt 60 ] && continue
      ;;
  esac

  echo "::error file=$file,line=$lineno::Possible credential committed. Remove it and rotate the key."
  echo "  $file:$lineno: $text"
  findings=1
done <<< "$candidates"

if [ "$findings" -ne 0 ]; then
  echo
  echo "If a hit is genuinely not key material, make it self-evidently so —"
  echo "use an EXAMPLE-suffixed AWS identifier, or elide the PEM body — rather"
  echo "than adding a path exclusion here. Exclusions rot; shapes do not."
  exit 1
fi

echo "No key material found."
