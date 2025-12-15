#!/usr/bin/env bash
# Pi5 Capture Lab — safe, standalone tool to iterate camera controls
#
# Purpose:
# - Non-destructive: independent of the production capture pipeline
# - Guardrails: requires --confirm to actually trigger a capture
# - Convenient: reads CAPTURE_PI_BASEURL from apps/backend/src/.env when PI_URL is unset
# - Portable: POSIX-y shell with curl + jq (jq optional)
#
# Usage examples:
#   scripts/pi5_capture_lab.sh status
#   scripts/pi5_capture_lab.sh get
#   scripts/pi5_capture_lab.sh set --exposure-us 8000 --gain 2.0 --ae false --awb false --colour-gains 2.1,1.8
#   scripts/pi5_capture_lab.sh profiles list
#   scripts/pi5_capture_lab.sh profiles save production --desc "Optimized indoor"
#   scripts/pi5_capture_lab.sh profiles load production
#   scripts/pi5_capture_lab.sh capture --confirm --full -o results/capture-lab/test.jpg
#   PI_URL=http://127.0.0.1:8000 scripts/pi5_capture_lab.sh status

set -euo pipefail

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SELF_DIR/.." && pwd)
RESULTS_DIR="$ROOT_DIR/results/capture-lab"
mkdir -p "$RESULTS_DIR"

command -v date >/dev/null 2>&1 || { echo "date required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl required" >&2; exit 1; }

_now_ts() { date +%Y%m%d-%H%M%S; }
_pretty() { 
  if command -v jq >/dev/null 2>&1; then
    # Be forgiving: if jq parse fails, fall back to raw output
    jq '.' 2>/dev/null || cat
  else
    cat
  fi
}

trim_whitespace() {
  local var="$1"
  # Remove leading whitespace
  var="${var#"${var%%[![:space:]]*}"}"
  # Remove trailing whitespace
  var="${var%"${var##*[![:space:]]}"}"
  echo "$var"
}

build_default_controls_json() {
  local cg="${DEFAULT_COLOUR_GAINS}"
  local r="${cg%%,*}"
  local b="${cg#*,}"
  r=$(trim_whitespace "$r")
  b=$(trim_whitespace "$b")
  local exposure="${DEFAULT_EXPOSURE_US}"
  local gain="${DEFAULT_ANALOGUE_GAIN}"
  local ae="${DEFAULT_AE}"
  local awb="${DEFAULT_AWB}"
  echo "{\"exposure_us\": $exposure, \"analogue_gain\": $gain, \"ae_enable\": $ae, \"awb_enable\": $awb, \"colour_gains\": [$r, $b]}"
}

# Resolve PI_URL from environment, backend .env, or default
resolve_pi_url() {
  if [ -n "${PI_URL:-}" ]; then
    echo "$PI_URL"
    return
  fi
  local backend_env="$ROOT_DIR/apps/backend/src/.env"
  if [ -f "$backend_env" ]; then
    local url
    url=$(grep -E '^\s*CAPTURE_PI_BASEURL=' "$backend_env" | tail -n1 | sed -E 's/^\s*CAPTURE_PI_BASEURL=\s*//') || true
    if [ -n "${url:-}" ]; then
      echo "$url"
      return
    fi
  fi
  echo "http://127.0.0.1:8000"
}

PI_URL=$(resolve_pi_url)
TIMEOUT=20
DEFAULT_STABILIZE_MS=${CAPTURE_LAB_STABILIZE_MS:-800}
DEFAULT_DISTORTION=${CAPTURE_LAB_DISTORTION:-1}
DEFAULT_PROFILE=${CAPTURE_LAB_PROFILE:-imx477_tuned_6mm_20251010_133159}
DEFAULT_EXPOSURE_US=${CAPTURE_LAB_DEFAULT_EXPOSURE_US:-10101}
DEFAULT_ANALOGUE_GAIN=${CAPTURE_LAB_DEFAULT_ANALOGUE_GAIN:-1.115}
DEFAULT_COLOUR_GAINS=${CAPTURE_LAB_DEFAULT_COLOUR_GAINS:-"2.38,1.98"}
DEFAULT_AE=$(printf '%s' "${CAPTURE_LAB_DEFAULT_AE:-false}" | tr 'A-Z' 'a-z')
DEFAULT_AWB=$(printf '%s' "${CAPTURE_LAB_DEFAULT_AWB:-false}" | tr 'A-Z' 'a-z')

usage() {
  cat <<USAGE
Pi5 Capture Lab

Commands:
  status                      Show /health and /profiles
  get                         Query /get (if implemented)
  set [options]               Apply camera controls via /set
    --exposure-us N           Exposure time in microseconds
    --gain F                  Analogue gain (float)
    --ae true|false           Auto-exposure enable
    --awb true|false          Auto white balance enable
    --colour-gains R,B        Colour gains (comma separated)
    --json '{...}'            Raw JSON body (overrides flags)
    --json-file path          Read JSON body from file

  profiles list               List profiles
  profiles save NAME [--desc TEXT]
  profiles load NAME

  capture [--full] [-o PATH] [--confirm] [--controls-json JSON]
    --full                    Use /capture/full and write image to file
    -o PATH                   Output file (default results/capture-lab/capture-<ts>.jpg)
    --confirm                 Required to actually call capture (otherwise dry-run)
    --controls-json JSON      Apply controls via /set immediately before capture
    --stabilize-ms N          Override stabilization wait (default: ${DEFAULT_STABILIZE_MS}ms)
    --correct                 Apply distortion correction (or CAPTURE_LAB_DISTORTION=1)
    --profile NAME            Distortion profile name (default env CAPTURE_LAB_PROFILE)

Options:
  --pi-url URL                Override kiosk base URL (default: $PI_URL)
  -h, --help                  Show this help

Examples:
  $0 status
  $0 set --exposure-us 8000 --gain 2.0 --ae false --awb false --colour-gains 2.1,1.8
  $0 capture --confirm --full -o results/capture-lab/test.jpg
USAGE
}

# Generic JSON POST helper (logs responses)
post_json() {
  local path="$1"; shift
  local body="$1"; shift || true
  local ts=$(_now_ts)
  local out_json="$RESULTS_DIR/resp-${path//\//_}-$ts.json"
  local trace_args=()
  local payload="$body"
  if [ -z "$payload" ]; then
    payload="{}"
  fi
  if [ "${CAPTURE_LAB_TRACE:-0}" = "1" ]; then
    local trace_file="$RESULTS_DIR/trace-${path//\//_}-$ts.log"
    trace_args=(--trace-ascii "$trace_file")
    echo "[trace] curl trace -> $trace_file" >&2
  fi
  echo "POST $PI_URL$path" >&2
  if [ -n "${body:-}" ]; then echo "$body" | _pretty >&2 || true; fi
  set +e
  local resp
  resp=$(curl -sS --max-time "$TIMEOUT" -H 'Content-Type: application/json' -X POST "$PI_URL$path" "${trace_args[@]}" --data-raw "$payload")
  local code=$?
  set -e
  echo "$resp" >"$out_json" || true
  echo "$resp"
  return $code
}

# Command: status
do_status() {
  echo "[status] PI_URL=$PI_URL"
  echo "- /health"
  set +e
  curl -sS --max-time "$TIMEOUT" "$PI_URL/health" | _pretty || true
  set -e
  echo "- /profiles"
  set +e
  curl -sS --max-time "$TIMEOUT" "$PI_URL/profiles" | _pretty || true
  set -e
}

# Command: get (optional endpoint; handle 404)
do_get() {
  echo "[get] $PI_URL/get"
  set +e
  local resp
  resp=$(curl -sS -w "\n%{http_code}" --max-time "$TIMEOUT" "$PI_URL/get")
  local code=$(echo "$resp" | tail -n1)
  local body=$(echo "$resp" | sed '$d')
  set -e
  if [ "$code" = "404" ]; then
    echo "Endpoint /get not implemented on kiosk (HTTP 404)." >&2
    return 0
  fi
  echo "$body" | _pretty
}

# Command: set (flags -> JSON)
do_set() {
  local exposure=""
  local gain=""
  local ae=""
  local awb=""
  local cgains=""
  local raw_json=""
  while [ ${#} -gt 0 ]; do
    case "$1" in
      --exposure-us) exposure="$2"; shift 2;;
      --gain) gain="$2"; shift 2;;
      --ae) ae="$2"; shift 2;;
      --awb) awb="$2"; shift 2;;
      --colour-gains) cgains="$2"; shift 2;;
      --json) raw_json="$2"; shift 2;;
      --json-file) raw_json=$(cat "$2"); shift 2;;
      --pi-url) PI_URL="$2"; shift 2;;
      -h|--help) usage; exit 0;;
      *) echo "Unknown option: $1" >&2; usage; exit 2;;
    esac
  done

  local body
  if [ -n "$raw_json" ]; then
    body="$raw_json"
  else
    local fields=()
    # Add numeric fields (ensure they're valid numbers)
    if [ -n "$exposure" ] && [[ "$exposure" =~ ^[0-9]+$ ]]; then
      fields+=("\"exposure_us\": $exposure")
    elif [ -n "$exposure" ]; then
      echo "Warning: Invalid exposure_us: $exposure (must be integer)" >&2
    fi

    if [ -n "$gain" ] && [[ "$gain" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
      fields+=("\"analogue_gain\": $gain")
    elif [ -n "$gain" ]; then
      echo "Warning: Invalid analogue_gain: $gain (must be numeric)" >&2
    fi

    # Add boolean fields
    if [ -n "$ae" ]; then fields+=("\"ae_enable\": $ae"); fi
    if [ -n "$awb" ]; then fields+=("\"awb_enable\": $awb"); fi
    if [ -n "$cgains" ]; then
      local r=$(echo "$cgains" | cut -d, -f1)
      local b=$(echo "$cgains" | cut -d, -f2)
      # Only add if both values are non-empty
      if [ -n "$r" ] && [ -n "$b" ]; then
        fields+=("\"colour_gains\": [$r, $b]")
      else
        echo "Warning: Invalid colour gains format: $cgains (expected: R,B)" >&2
      fi
    fi
    local joined=""
    if [ ${#fields[@]} -gt 0 ]; then
      joined="${fields[0]}"
      local i
      for i in "${fields[@]:1}"; do
        joined="$joined, $i"
      done
      body="{$joined}"
    else
      echo "Warning: No valid camera parameters specified; sending empty request" >&2
      body="{}"
    fi
  fi

  post_json "/set" "$body" | _pretty
}

# Command: profiles
do_profiles() {
  local sub=${1:-}
  shift || true
  case "$sub" in
    list)
      curl -sS --max-time "$TIMEOUT" "$PI_URL/profiles" | _pretty
      ;;
    save)
      local name=${1:-}; shift || true
      local desc=""
      while [ ${#} -gt 0 ]; do
        case "$1" in
          --desc) desc="$2"; shift 2;;
          --pi-url) PI_URL="$2"; shift 2;;
          *) echo "Unknown option: $1" >&2; usage; exit 2;;
        esac
      done
      [ -z "$name" ] && { echo "profiles save requires NAME" >&2; exit 2; }
      local body
      if [ -n "$desc" ]; then body="{\"name\":\"$name\",\"description\":\"$desc\"}"; else body="{\"name\":\"$name\"}"; fi
      post_json "/profiles/save" "$body" | _pretty
      ;;
    load)
      local name=${1:-}
      [ -z "$name" ] && { echo "profiles load requires NAME" >&2; exit 2; }
      post_json "/profiles/load" "{\"name\":\"$name\"}" | _pretty
      ;;
    *)
      echo "Unknown profiles subcommand: $sub" >&2; usage; exit 2;
      ;;
  esac
}

# Command: capture (guarded by --confirm)
do_capture() {
  local full=0
  local output=""
  local confirm=0
  local controls_json=""
  local stabilize_ms=$DEFAULT_STABILIZE_MS
  local correct=$DEFAULT_DISTORTION
  local profile="$DEFAULT_PROFILE"
  while [ ${#} -gt 0 ]; do
    case "$1" in
      --full) full=1; shift;;
      -o) output="$2"; shift 2;;
      --confirm) confirm=1; shift;;
      --controls-json) controls_json="$2"; shift 2;;
      --stabilize-ms) stabilize_ms="$2"; shift 2;;
      --correct) correct=1; shift;;
      --no-correct) correct=0; shift;;
      --profile) profile="$2"; shift 2;;
      --pi-url) PI_URL="$2"; shift 2;;
      -h|--help) usage; exit 0;;
      *) echo "Unknown option: $1" >&2; usage; exit 2;;
    esac
  done

  if [ "$confirm" -ne 1 ]; then
    echo "[capture] Dry-run (no --confirm). Would call: $PI_URL/capture" >&2
    [ -n "$output" ] && echo "[capture] Would fetch image to: $output.jpg" >&2
    return 0
  fi

  # Optionally apply inline controls before capture (defaults if none supplied)
  local active_controls="$controls_json"
  if [ -z "$active_controls" ] || [ "$active_controls" = "{}" ]; then
    active_controls=$(build_default_controls_json)
    echo "[capture] Using sandbox default controls (exposure ${DEFAULT_EXPOSURE_US}μs, gain ${DEFAULT_ANALOGUE_GAIN})"
  fi

  if [ -n "$active_controls" ] && [ "$active_controls" != "{}" ]; then
    echo "[capture] Applying inline controls via /set"
    post_json "/set" "$active_controls" | _pretty
    if [ "${stabilize_ms:-0}" -gt 0 ]; then
      local sleep_secs
      sleep_secs=$(awk "BEGIN { printf \"%.3f\", ${stabilize_ms:-0} / 1000 }")
      echo "[capture] Waiting ${stabilize_ms}ms for stabilization"
      sleep "$sleep_secs"
    fi
  fi

  # Trigger capture and get UID
  echo "POST $PI_URL/capture"
  local resp
  resp=$(curl -sS --max-time 60 -X POST "$PI_URL/capture" -H 'Content-Type: application/json' -d '{}')
  echo "$resp" | _pretty

  # If --full, fetch the image via SFTP inbox
  if [ "$full" -eq 1 ]; then
    local uid=""
    if command -v jq >/dev/null 2>&1; then
      # Be resilient to non-JSON prefixes; suppress jq errors and fallback to grep
      set +e
      uid=$(printf '%s' "$resp" | jq -er '.uid' 2>/dev/null)
      local jq_code=$?
      set -e
      if [ $jq_code -ne 0 ] || [ -z "$uid" ] || [ "$uid" = "null" ]; then
        uid=$(printf '%s' "$resp" | grep -oP '"uid"\s*:\s*"\K[^"]+')
      fi
    else
      uid=$(printf '%s' "$resp" | grep -oP '"uid"\s*:\s*"\K[^"]+')
    fi

    if [ -n "$uid" ] && [ "$uid" != "null" ]; then
      # Image should be in SFTP inbox on Fedora
      local inbox_dir="$ROOT_DIR/data/sftp-inbox"
      local src_img="$inbox_dir/${uid}.jpg"

      # Wait briefly for SFTP transfer
      echo "Waiting for SFTP transfer of ${uid}.jpg..."
      local wait_count=0
      while [ ! -f "$src_img" ] && [ $wait_count -lt 10 ]; do
        sleep 0.5
        wait_count=$((wait_count + 1))
      done

      if [ -f "$src_img" ]; then
        [ -z "$output" ] && output="$RESULTS_DIR/capture-$(_now_ts).jpg"
        # Ensure .jpg extension
        [[ "$output" != *.jpg ]] && output="${output}.jpg"
        cp "$src_img" "$output"
        echo "Image saved: $output"
        local final_path="$output"

        # Apply distortion correction if requested
        if [ "$correct" -eq 1 ]; then
          local distortion_script="$ROOT_DIR/scripts/apply_distortion_correction.py"
          if [ -f "$distortion_script" ] && command -v python3 >/dev/null 2>&1; then
            echo "Applying distortion correction..."
            local distortion_output
            distortion_output=$(dirname "$output")
            set +e
            local distortion_result
            distortion_result=$(python3 "$distortion_script" --image "$output" --output "$distortion_output" ${profile:+--profile "$profile"} 2>&1)
            local distortion_code=$?
            set -e

            if [ $distortion_code -eq 0 ]; then
            local json_line corrected_path=""
            json_line=$(echo "$distortion_result" | tail -n1)
            if command -v jq >/dev/null 2>&1; then
              set +e
              corrected_path=$(echo "$json_line" | jq -r '.output_image // empty' 2>/dev/null)
              set -e
            fi
            if [ -z "$corrected_path" ]; then
              set +e
              corrected_path=$(echo "$json_line" | sed -n 's/.*"output_image":[[:space:]]*"\([^"]\+\)".*/\1/p' | head -n1)
              set -e
            fi

            if [ -n "$corrected_path" ] && [ -f "$corrected_path" ]; then
              echo "Distortion correction applied: $corrected_path"
              final_path="$corrected_path"
            else
                echo "Warning: Distortion correction succeeded but file missing; using original" >&2
              fi
            else
              echo "Warning: Distortion correction failed (code=$distortion_code); using original" >&2
              echo "$distortion_result" | head -n3 >&2
            fi
          else
            echo "Skipping distortion correction (script or python3 missing)" >&2
          fi
        fi

        echo "IMAGE_PATH:$final_path"
      else
        echo "Warning: Image ${uid}.jpg not found in SFTP inbox after 5s" >&2
        echo "Check: $inbox_dir/" >&2
      fi
    fi
  fi
}

main() {
  local cmd=${1:-}
  if [ -z "$cmd" ]; then usage; exit 2; fi
  shift || true
  case "$cmd" in
    -h|--help) usage ;;
    status) do_status ;; 
    get) do_get ;;
    set) do_set "$@" ;;
    profiles) do_profiles "$@" ;;
    capture) do_capture "$@" ;;
    *) echo "Unknown command: $cmd" >&2; usage; exit 2 ;;
  esac
}

main "$@"
