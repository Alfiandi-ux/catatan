#!/usr/bin/env bash
# Bangun APK Catatan tanpa Gradle, langsung dari Termux.
#
# Pemakaian:  ./android/build-termux.sh [berkas-keluaran.apk]
#
# Kebutuhan: openjdk-17, aapt2, apksigner, dx (pkg install ...) dan android.jar
# (unduh platform Android 34, otomatis bila belum ada).
set -euo pipefail

ANDROID_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$ANDROID_DIR/.." && pwd)"
BUILD="$ANDROID_DIR/build"
APP_SRC="$ANDROID_DIR/app/src/main"
SDK_DIR="${ANDROID_SDK_DIR:-$HOME/build/sdk}"
JAR="${ANDROID_JAR:-$SDK_DIR/android-34/android.jar}"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0.0}"
OUT="${1:-$ANDROID_DIR/build/Catatan-$VERSION_NAME.apk}"

log() { printf '\033[1;33m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

for tool in aapt2 javac java apksigner keytool python3 zip; do
  command -v "$tool" >/dev/null 2>&1 || die "Alat tidak ditemukan: $tool (jalankan: pkg install openjdk-17 aapt2 apksigner dx)"
done

if [ ! -f "$JAR" ]; then
  log "android.jar belum ada, mengunduh platform Android 34..."
  mkdir -p "$SDK_DIR"
  curl -fL -o "$SDK_DIR/platform.zip" https://dl.google.com/android/repository/platform-34-ext7_r02.zip
  unzip -oq "$SDK_DIR/platform.zip" -d "$SDK_DIR"
  rm -f "$SDK_DIR/platform.zip"
  [ -f "$JAR" ] || die "android.jar tetap tidak ditemukan di $JAR"
fi

log "Menyiapkan $VERSION_NAME ($VERSION_CODE)"
rm -rf "$BUILD"
mkdir -p "$BUILD/res" "$BUILD/classes" "$BUILD/assets/www/assets"

cp "$ROOT/index.html" "$ROOT/manifest.webmanifest" "$ROOT/sw.js" "$BUILD/assets/www/"
cp "$ROOT"/icon*.png "$ROOT"/icon*.svg "$BUILD/assets/www/"
cp "$ROOT/assets/app.js" "$ROOT/assets/styles.css" "$BUILD/assets/www/assets/"
sed 's|<manifest |<manifest package="id.catatan.app" |' \
  "$APP_SRC/AndroidManifest.xml" > "$BUILD/AndroidManifest.xml"

log "Kompilasi resource (aapt2)"
aapt2 compile --dir "$APP_SRC/res" -o "$BUILD/res.zip"
aapt2 link -o "$BUILD/base.apk" \
  -I "$JAR" \
  --manifest "$BUILD/AndroidManifest.xml" \
  -R "$BUILD/res.zip" \
  -A "$BUILD/assets" \
  --min-sdk-version 23 \
  --target-sdk-version 34 \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  --auto-add-overlay

log "Kompilasi Java (javac)"
find "$APP_SRC/java" -name '*.java' > "$BUILD/sources.txt"
javac -source 8 -target 8 -Xlint:-options \
  -bootclasspath "$JAR" \
  -d "$BUILD/classes" \
  @"$BUILD/sources.txt"

log "Membuat classes.dex (dx)"
dx --dex --min-sdk-version=23 --output="$BUILD/classes.dex" "$BUILD/classes"
( cd "$BUILD" && zip -q base.apk classes.dex )

log "Menyelaraskan APK"
python3 "$ANDROID_DIR/tools/zipalign.py" "$BUILD/base.apk" "$BUILD/aligned.apk"

KEYSTORE="$ANDROID_DIR/release.keystore"
if [ ! -f "$KEYSTORE" ]; then
  log "Membuat keystore rilis baru"
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" \
    -alias catatan \
    -storepass catatan -keypass catatan \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Catatan, OU=Aplikasi Catatan, O=Catatan, L=Jakarta, C=ID" >/dev/null 2>&1
fi

log "Menandatangani APK"
mkdir -p "$(dirname "$OUT")"
apksigner sign \
  --ks "$KEYSTORE" \
  --ks-pass pass:catatan \
  --key-pass pass:catatan \
  --ks-key-alias catatan \
  --min-sdk-version 23 \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --v3-signing-enabled true \
  --out "$OUT" \
  "$BUILD/aligned.apk"

apksigner verify --print-certs "$OUT" | sed -n '1,4p'
rm -rf "$BUILD/base.apk" "$BUILD/aligned.apk"
log "Selesai: $OUT ($(du -h "$OUT" | cut -f1))"
