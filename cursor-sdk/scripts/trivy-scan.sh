#!/usr/bin/env bash
# CI と同じ Trivy スキャンをローカルで回す: CRITICAL/HIGH/MEDIUM、Trivy JSON、検出しても exit 0。
# ここはコントロールプレーンなので、スキャン対象のリポジトリをパスで渡す。
#
#   bash scripts/trivy-scan.sh ~/src/petclinic
#   bash scripts/trivy-scan.sh --skip-resolve ~/src/petclinic
#
# 出力: カレントディレクトリの trivy-report.json
# 続けてトリアージまで回すなら:
#   npx tsx src/cli.ts run --report ./trivy-report.json --cwd <対象> --runtime local --skip-remediate
set -euo pipefail

SKIP_RESOLVE=0
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --skip-resolve) SKIP_RESOLVE=1 ;;
    -h|--help)
      echo "Usage: $0 [--skip-resolve] <path-to-repository>"
      echo "Writes trivy-report.json in the current directory."
      exit 0
      ;;
    -*)
      echo "unknown argument: $arg" >&2
      exit 64
      ;;
    *)
      if [[ -n "$TARGET" ]]; then
        echo "only one repository path is supported (got '$TARGET' and '$arg')" >&2
        exit 64
      fi
      TARGET="$arg"
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "スキャン対象のリポジトリのパスを渡してください（例: $0 ~/src/petclinic）" >&2
  exit 64
fi
if [[ ! -d "$TARGET" ]]; then
  echo "ディレクトリが見つかりません: $TARGET" >&2
  exit 1
fi
if ! command -v trivy >/dev/null 2>&1; then
  echo "trivy が見つかりません。macOS なら: brew install trivy" >&2
  exit 1
fi

TARGET="$(cd "$TARGET" && pwd)"
OUT="$(pwd)/trivy-report.json"

# Maven だけは ~/.m2 を埋めておかないと Maven Central を叩いて 429 になりやすい。
if [[ "$SKIP_RESOLVE" -eq 0 && -f "$TARGET/pom.xml" && -x "$TARGET/mvnw" ]]; then
  echo "Resolving Maven dependencies into ~/.m2…" >&2
  (cd "$TARGET" && ./mvnw -B -DskipTests dependency:resolve) ||
    echo "dependency:resolve に失敗しました。マニフェストのみでスキャンします" >&2
fi

# --skip-dirs target があるので、対象ディレクトリ名が target だと対象ごと除外される点に注意。
FLAGS=(
  --scanners vuln --severity CRITICAL,HIGH,MEDIUM
  --skip-dirs target --skip-dirs node_modules --skip-dirs vendor
  --skip-dirs dist --skip-dirs .git
)

echo "Scanning $TARGET (CRITICAL,HIGH,MEDIUM)…" >&2
trivy fs "${FLAGS[@]}" --format json --output "$OUT" "$TARGET"
trivy fs "${FLAGS[@]}" --exit-code 0 --format table "$TARGET"

echo "Wrote $OUT" >&2
