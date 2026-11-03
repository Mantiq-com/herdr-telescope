#!/usr/bin/env bash
# The searches and previews of the Telescope mod for the Herdr app. The mod runs
# this command on the machine that holds the files, on every keystroke and every
# move of the selection, so each call must end quickly with bounded output: the
# app cannot cancel a command, keeps at most 8 MiB of its output, and kills it
# after 30 seconds.
#
#   herdr-telescope files [--no-ignore] [--case-sensitive] [--changed] -- <root> <query>
#       Paths under <root>, best match first, one per line. --changed keeps only
#       what git reports as changed there.
#   herdr-telescope grep [--no-ignore] [--case-sensitive] [--changed] -- <root> <query>
#       Lines under <root>, best match first, as path, line, column and text
#       separated by the unit separator (0x1f).
#   herdr-telescope preview [--line N | --first N] [--page N] -- <file>
#       One JSON object describing what to show for <file>. Text comes as a
#       window of lines around line N, or starting at line N with --first.
#
# rg, fzf and jq are required. Every preview converter is optional: without it
# the preview shows the file's details and names the tool to install.
set -o nounset

readonly RESULT_LIMIT=500
readonly RANK_LIMIT=50000
readonly SEARCH_SECONDS=8
readonly CONVERT_SECONDS=20
readonly LOCK_SECONDS=8
readonly TEXT_BYTES=65536
readonly SNIFF_BYTES=8192
readonly WINDOW_LINES=400
readonly LINES_ABOVE_MATCH=10
readonly LIST_LINES=2000
readonly IMAGE_PIXELS=1400
readonly VIDEO_PIXELS=1024
readonly CACHE_MINUTES=1440
readonly SEPARATOR=$'\x1f'

fail() {
  echo "herdr-telescope: ${1}" >&2
  exit 2
}

have() {
  command -v "${1}" > /dev/null
}

require() {
  local tool
  for tool in "$@"; do
    have "${tool}" || fail "${tool} is not installed on this machine"
  done
}

# Prints one pattern per search term. Each pattern matches the term's letters in
# order, which is what fzf calls a match, so rg narrows the lines at full speed
# and fzf only ranks the survivors. Terms that fzf excludes (!word) narrow
# nothing here. Punctuation is written as a hex escape because some escaped
# characters, such as \<, have a meaning of their own in rg's regex syntax.
subsequence_patterns() {
  jq --null-input --raw-output --arg query "${1}" --arg exact_marker "'" '
    def hex: "0123456789abcdef" as $digits
      | $digits[(. / 16 | floor):(. / 16 | floor) + 1] + $digits[(. % 16):(. % 16) + 1];
    def letter:
      if (. >= 48 and . <= 57) or (. >= 65 and . <= 90) or (. >= 97 and . <= 122) or . > 127
      then [.] | implode
      else "\\x{" + hex + "}"
      end;
    $query
    | [splits(" +")]
    | map(select(startswith("!") | not))
    | map(ltrimstr($exact_marker) | ltrimstr("^") | rtrimstr("$"))
    | map(select(length > 0))
    | .[]
    | explode
    | map(letter)
    | join(".*")
  '
}

enter_root() {
  cd "${1}" || fail "cannot read ${1}"
  if [ "${changed}" = true ]; then
    require git
    git rev-parse --is-inside-work-tree > /dev/null 2>&1 || fail "${1} is not a git repository"
  fi
}

# The files git reports as changed. A deleted file cannot be opened, so it is left
# out, and --no-renames gives each change one entry where a rename would take two.
changed_files() {
  timeout "${SEARCH_SECONDS}" git --no-optional-locks -c core.fsmonitor=false status \
    --porcelain=v1 -z --no-renames --untracked-files=all \
    | while IFS= read -r -d '' entry; do
      [[ "${entry:0:2}" == *D* ]] || printf '%s\n' "${entry:3}"
    done
}

list_files() {
  if [ "${changed}" = true ]; then
    changed_files
    return
  fi
  local listing=(rg --files --hidden --glob '!.git' --no-messages --color=never)
  [ "${no_ignore}" = true ] && listing+=(--no-ignore)
  timeout "${SEARCH_SECONDS}" "${listing[@]}"
}

search_files() {
  local root="${1}" query="${2}"
  local ranking=(fzf "--filter=${query}" --scheme=path)
  [ "${case_sensitive}" = true ] && ranking+=(--no-ignore-case)
  enter_root "${root}"
  if [ -z "${query}" ]; then
    list_files | LC_ALL=C sort | head --lines="${RESULT_LIMIT}"
  else
    list_files | "${ranking[@]}" | head --lines="${RESULT_LIMIT}"
  fi
}

# With no path rg searches a readable stdin instead of the folder.
matching_lines() {
  if [ "${changed}" = true ]; then
    changed_files | tr '\n' '\0' \
      | timeout "${SEARCH_SECONDS}" xargs --null --no-run-if-empty "${search[@]}" "${patterns[@]}" --
  else
    timeout "${SEARCH_SECONDS}" "${search[@]}" "${patterns[@]}" < /dev/null
  fi
}

search_content() {
  local root="${1}" query="${2}"
  local patterns=() pattern
  while IFS= read -r pattern; do
    patterns+=(-e "${pattern}")
  done < <(subsequence_patterns "${query}")
  [ "${#patterns[@]}" -gt 0 ] || return 0

  local search=(rg --hidden --glob '!.git' --no-messages --color=never
    --line-number --column --no-heading --with-filename
    --max-filesize=1M --max-columns=300 --max-columns-preview
    "--field-match-separator=${SEPARATOR}")
  [ "${no_ignore}" = true ] && search+=(--no-ignore)
  local ranking=(fzf "--filter=${query}" "--delimiter=${SEPARATOR}" --nth=4..)
  # Without --case-sensitive rg keeps every case, and fzf applies its smart case.
  if [ "${case_sensitive}" = true ]; then
    search+=(--case-sensitive)
    ranking+=(--no-ignore-case)
  else
    search+=(--ignore-case)
  fi
  enter_root "${root}"
  matching_lines \
    | head --lines="${RANK_LIMIT}" \
    | "${ranking[@]}" \
    | head --lines="${RESULT_LIMIT}"
}

# A preview tool parses a file that may be hostile. Where bubblewrap works, the tool
# runs with no network and sees only the system, that file and the work folder: not
# the home folder, not /run where decrypted secrets can live, and not this
# environment, which can hold tokens. Where bubblewrap is missing or cannot run, for
# instance inside another sandbox, the tool runs as it is.
make_sandbox() {
  [ "${sandbox_made}" = true ] && [ "$#" = 0 ] && return 0
  sandbox_made=true
  sandbox=()
  have bwrap || return 0
  local box=(bwrap --unshare-all --die-with-parent --new-session --clearenv
    --setenv HOME "${HOME}" --setenv PATH "${PATH}" --setenv TMPDIR /tmp
    --dev /dev --proc /proc --tmpfs /tmp --tmpfs "${HOME}")
  local path
  for path in /nix/store /usr /bin /sbin /lib /lib32 /lib64 /etc /run/current-system; do
    box+=(--ro-bind-try "${path}" "${path}")
  done
  box+=(--bind "${work}" "${work}" --ro-bind "${file}" "${file}" "$@")
  "${box[@]}" "${BASH}" -c : 2> /dev/null && sandbox=("${box[@]}")
}

# The tool's real path is used because the sandbox hides links in the home folder,
# such as ~/.nix-profile.
run_tool() {
  local program
  program=$(readlink --canonicalize "$(command -v "${1}")")
  shift
  timeout "${CONVERT_SECONDS}" "${sandbox[@]}" "${program}" "$@"
}

emit_text() {
  local kind="${1}" language="${2}" first_line="${3}" hint="${4}"
  jq --null-input --compact-output \
    --rawfile text "${work}/text" \
    --arg kind "${kind}" --arg language "${language}" --arg hint "${hint}" \
    --argjson first_line "${first_line}" \
    '{ $kind, $language, $first_line, $hint, $text }'
}

# The JSON carries the image, so that a file on another machine previews the
# same way, and jq reads it from a file because one argument is limited to 128 KiB.
emit_image() {
  local path="${1}" format="${2}" width="${3}" height="${4}" pages="${5}" details="${6}"
  base64 --wrap=0 "${path}" > "${work}/base64"
  jq --null-input --compact-output \
    --rawfile base64 "${work}/base64" \
    --arg format "${format}" --arg details "${details}" \
    --argjson width "${width}" --argjson height "${height}" \
    --argjson page "${page}" --argjson pages "${pages}" \
    '{ kind: "image", $format, $width, $height, $page, $pages, $details, $base64 }'
}

png_size() {
  od --address-radix=n --skip-bytes=16 --read-bytes=8 --format=u4 --endian=big "${1}"
}

show_details() {
  local hint="${1:-}"
  {
    have file && printf 'Type: %s\n' "$(run_tool file --brief "${file}")"
    printf 'Size: %s bytes\n' "$(stat --format=%s "${file}")"
    printf 'Modified: %s\n\n' "$(date --reference="${file}" '+%F %T')"
    od --address-radix=x --format=x1z --read-bytes=512 "${file}"
  } > "${work}/text"
  emit_text details "" 1 "${hint}"
}

# A window of the file rather than the file: the app highlights a whole document
# again on each change, and a large one would make browsing stutter.
show_text() {
  local kind="${1}"
  local start="${first}"
  if [ "${start}" = 0 ]; then
    start=$((line > LINES_ABOVE_MATCH ? line - LINES_ABOVE_MATCH : 1))
  fi
  local last=$((start + WINDOW_LINES - 1))
  sed --quiet "${start},${last}p;${last}q" "${file}" 2> /dev/null | head --bytes="${TEXT_BYTES}" > "${work}/text"
  local name="${file##*/}"
  emit_text "${kind}" "${name##*.}" "${start}" ""
}

# The image reaches magick on stdin with its format named, so neither the file's
# name nor its contents can select one of ImageMagick's scripting formats.
show_raster() {
  have magick || {
    show_details "Install ImageMagick to preview this image."
    return
  }
  local size
  if ! size=$(run_tool magick "${coder}:-[0]" -auto-orient \
    -thumbnail "${IMAGE_PIXELS}x${IMAGE_PIXELS}>" -quality 80 \
    -write "webp:${work}/image" -format '%w %h' info: < "${file}" 2> /dev/null); then
    show_details "ImageMagick could not read this image."
    return
  fi
  read -r width height <<< "${size}"
  emit_image "${work}/image" webp "${width}" "${height}" 1 ""
}

# magick would hand an SVG to whatever renderer it finds, Inkscape included.
show_svg() {
  have rsvg-convert || {
    show_details "Install librsvg (rsvg-convert) to preview SVG files."
    return
  }
  if ! run_tool rsvg-convert --keep-aspect-ratio \
    --width="${IMAGE_PIXELS}" --height="${IMAGE_PIXELS}" \
    --output="${work}/image.png" < "${file}" 2> /dev/null; then
    show_details "rsvg-convert could not read this file."
    return
  fi
  read -r width height <<< "$(png_size "${work}/image.png")"
  emit_image "${work}/image.png" png "${width}" "${height}" 1 ""
}

show_pdf() {
  local source="${1}"
  if ! have pdftoppm || ! have pdfinfo; then
    show_details "Install poppler-utils (pdftoppm, pdfinfo) to preview PDF files."
    return
  fi
  local pages
  pages=$(run_tool pdfinfo "${source}" 2> /dev/null | sed --quiet 's/^Pages: *//p')
  [ -n "${pages}" ] && [ "${pages}" -gt 0 ] || {
    show_details "This PDF is locked or cannot be read."
    return
  }
  [ "${page}" -le "${pages}" ] || page="${pages}"
  if ! run_tool pdftoppm -f "${page}" -l "${page}" -singlefile -png \
    -scale-to "${IMAGE_PIXELS}" "${source}" "${work}/page" 2> /dev/null; then
    show_details "This PDF page cannot be rendered."
    return
  fi
  read -r width height <<< "$(png_size "${work}/page.png")"
  emit_image "${work}/page.png" png "${width}" "${height}" "${pages}" ""
}

# Converted documents are kept, so that turning a page does not convert again. A
# private profile keeps an open LibreOffice window from taking the conversion
# over, and the lock keeps two conversions from sharing that profile.
show_office() {
  have soffice || {
    show_details "Install LibreOffice (soffice) to preview this document."
    return
  }
  local cache="${XDG_RUNTIME_DIR:-${HOME}/.cache}/herdr-telescope"
  mkdir --parents "${cache}" || fail "cannot create ${cache}"
  chmod 700 "${cache}"
  make_sandbox --bind "${cache}" "${cache}"
  local key
  key=$(printf '%s:%s' "${file}" "$(stat --format='%Y:%s' "${file}")" | sha256sum)
  local pdf="${cache}/${key%% *}.pdf"
  if [ ! -f "${pdf}" ]; then
    find "${cache}" -maxdepth 1 -name '*.pdf' -mmin "+${CACHE_MINUTES}" -delete
    mkdir "${work}/office"
    (
      flock --timeout="${LOCK_SECONDS}" 9 \
        && run_tool soffice "-env:UserInstallation=file://${cache}/profile" \
          --headless --convert-to pdf --outdir "${work}/office" "${file}"
    ) 9> "${cache}/soffice.lock" > /dev/null 2>&1
    local converted=("${work}"/office/*.pdf)
    [ -f "${converted[0]}" ] || {
      show_details "LibreOffice could not convert this document."
      return
    }
    mv "${converted[0]}" "${pdf}"
  fi
  show_pdf "${pdf}"
}

media_details() {
  have ffprobe || return 0
  run_tool ffprobe -v error -show_entries \
    'format=duration,bit_rate:format_tags:stream=codec_type,codec_name,width,height' \
    -of default=noprint_wrappers=1 "${file}" 2> /dev/null
}

show_video() {
  have ffmpegthumbnailer || {
    show_details "Install ffmpegthumbnailer to preview videos."
    return
  }
  if ! run_tool ffmpegthumbnailer -i "${file}" -o "${work}/frame.png" \
    -s "${VIDEO_PIXELS}" -c png > /dev/null 2>&1; then
    show_details "ffmpegthumbnailer could not read this video."
    return
  fi
  read -r width height <<< "$(png_size "${work}/frame.png")"
  emit_image "${work}/frame.png" png "${width}" "${height}" 1 "$(media_details)"
}

show_audio() {
  have ffprobe || {
    show_details "Install ffmpeg (ffprobe) to read this file's tags."
    return
  }
  media_details > "${work}/text"
  emit_text text "" 1 ""
}

show_archive() {
  have bsdtar || {
    show_details "Install libarchive (bsdtar) to list this archive."
    return
  }
  run_tool bsdtar --list --file "${file}" 2> /dev/null \
    | head --lines="${LIST_LINES}" > "${work}/text"
  [ -s "${work}/text" ] || {
    show_details "bsdtar could not read this archive."
    return
  }
  emit_text text "" 1 ""
}

show_sqlite() {
  have sqlite3 || {
    show_details "Install sqlite to read this database's schema."
    return
  }
  if ! run_tool sqlite3 -readonly "${file}" .schema > "${work}/text" 2> /dev/null; then
    show_details "sqlite3 could not read this database."
    return
  fi
  emit_text text sql 1 ""
}

has_no_nul() {
  [ "$(head --bytes="${SNIFF_BYTES}" "${file}" | tr --delete --complement '\000' | wc --bytes)" = 0 ]
}

detect_binary() {
  have file || return 0
  make_sandbox
  case "$(run_tool file --brief --mime-type "${file}")" in
    image/png) kind=raster coder=png ;;
    image/jpeg) kind=raster coder=jpeg ;;
    image/gif) kind=raster coder=gif ;;
    image/webp) kind=raster coder=webp ;;
    image/bmp) kind=raster coder=bmp ;;
    image/tiff) kind=raster coder=tiff ;;
    image/avif) kind=raster coder=avif ;;
    image/heic) kind=raster coder=heic ;;
    image/vnd.microsoft.icon) kind=raster coder=ico ;;
    application/pdf) kind=pdf ;;
    application/vnd.sqlite3) kind=sqlite ;;
    application/zip | application/x-tar | application/gzip | application/x-7z-compressed) kind=archive ;;
    video/*) kind=video ;;
    audio/*) kind=audio ;;
  esac
}

detect() {
  local name="${file##*/}" extension=""
  [[ "${name}" == *.* ]] && extension="${name##*.}"
  case "${extension,,}" in
    md | markdown) kind=markdown ;;
    png | gif | webp | bmp | avif | ico | tiff | jpeg | heic) kind=raster coder="${extension,,}" ;;
    jpg) kind=raster coder=jpeg ;;
    tif) kind=raster coder=tiff ;;
    heif) kind=raster coder=heic ;;
    svg) kind=svg ;;
    pdf) kind=pdf ;;
    doc | docx | odt | rtf | xls | xlsx | ods | ppt | pptx | odp) kind=office ;;
    mp4 | mkv | webm | mov | avi | m4v) kind=video ;;
    mp3 | flac | ogg | opus | wav | m4a | aac) kind=audio ;;
    zip | jar | war | tar | tgz | gz | bz2 | xz | zst | 7z | rar | deb | rpm | iso) kind=archive ;;
    sqlite | sqlite3) kind=sqlite ;;
    *)
      if has_no_nul; then
        kind=text
      else
        kind=binary
        detect_binary
      fi
      ;;
  esac
}

preview() {
  file="${1}"
  [ "${file:0:1}" = / ] || file="${PWD}/${file}"
  [ -f "${file}" ] || fail "${file} is not a file"
  require jq
  work=$(mktemp --directory)
  trap 'rm --recursive --force "${work}"' EXIT
  kind=binary
  coder=""
  sandbox=()
  sandbox_made=false
  detect
  # Text is only read, and browsing it should cost nothing extra.
  if [ "${kind}" != text ] && [ "${kind}" != markdown ]; then
    make_sandbox
  fi
  case "${kind}" in
    text | markdown) show_text "${kind}" ;;
    raster) show_raster ;;
    svg) show_svg ;;
    pdf) show_pdf "${file}" ;;
    office) show_office ;;
    video) show_video ;;
    audio) show_audio ;;
    archive) show_archive ;;
    sqlite) show_sqlite ;;
    *) show_details ;;
  esac
}

command="${1:-}"
[ "$#" -gt 0 ] && shift
no_ignore=false
case_sensitive=false
changed=false
line=0
first=0
page=1
arguments=()
while [ "$#" -gt 0 ]; do
  case "${1}" in
    --no-ignore)
      no_ignore=true
      shift
      ;;
    --case-sensitive)
      case_sensitive=true
      shift
      ;;
    --changed)
      changed=true
      shift
      ;;
    --line)
      [[ "${2:-}" =~ ^[0-9]+$ ]] || fail "--line needs a number"
      line="${2}"
      shift 2
      ;;
    --first)
      [[ "${2:-}" =~ ^[0-9]+$ ]] || fail "--first needs a number"
      first="${2}"
      shift 2
      ;;
    --page)
      [[ "${2:-}" =~ ^[0-9]+$ ]] || fail "--page needs a number"
      page="${2}"
      shift 2
      ;;
    --)
      shift
      arguments+=("$@")
      break
      ;;
    *)
      arguments+=("${1}")
      shift
      ;;
  esac
done
[ "${page}" -gt 0 ] || page=1

case "${command}" in
  files)
    [ "${#arguments[@]}" = 2 ] || fail "usage: herdr-telescope files [--no-ignore] [--case-sensitive] [--changed] -- <root> <query>"
    require rg fzf
    search_files "${arguments[0]}" "${arguments[1]}"
    ;;
  grep)
    [ "${#arguments[@]}" = 2 ] || fail "usage: herdr-telescope grep [--no-ignore] [--case-sensitive] [--changed] -- <root> <query>"
    require rg fzf jq
    search_content "${arguments[0]}" "${arguments[1]}"
    ;;
  preview)
    [ "${#arguments[@]}" = 1 ] || fail "usage: herdr-telescope preview [--line N | --first N] [--page N] -- <file>"
    preview "${arguments[0]}"
    ;;
  *)
    fail "usage: herdr-telescope files|grep|preview ..."
    ;;
esac
