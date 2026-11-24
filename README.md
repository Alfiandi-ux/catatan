# Catatan — ruang kerja pribadi

Aplikasi catatan ringan yang berjalan **sepenuhnya offline**. Tersedia sebagai APK
Android (tanpa Play Store, tanpa akun, tanpa internet) dan sebagai PWA yang bisa
dibuka di browser mana pun.

![Ikon Catatan](icon-192.png)

## Unduh APK

Ambil versi terbaru dari halaman rilis:

**<https://github.com/Alfiandi-ux/catatan/releases/latest>**

Tautan langsung ke berkas terbaru: [`Catatan.apk`](https://github.com/Alfiandi-ux/catatan/releases/latest/download/Catatan.apk)

### Cara memasang di HP Android

1. Unduh berkas `.apk` lewat browser HP.
2. Buka **Notification** → ketuk berkasnya, atau buka **File Manager → Download**.
3. Jika muncul peringatan, pilih **Setelan** → izinkan **Instal aplikasi tidak dikenal**
   untuk browser/file manager yang dipakai, lalu kembali dan ketuk **Instal**.
4. Selesai. Ikon **Catatan** muncul di laci aplikasi.

APK ini ditandatangani sendiri (self-signed), jadi Play Protect bisa menampilkan
"aplikasi tidak dikenal". Itu normal untuk aplikasi di luar Play Store.

**Spesifikasi:** Android 6.0+ (minSdk 23), target Android 14, ukuran ±100 KB,
tanpa izin internet, tanpa iklan, tanpa pelacakan.

## Fitur

- **Tulis & simpan otomatis** — tidak ada tombol simpan, semua perubahan tersimpan di perangkat.
- **Command palette** (`Ctrl K`) — cari catatan dan jalankan perintah dari satu tempat.
- **Mode editor 3-in-1** (`Ctrl E`) — tulis, pisah (editor + pratinjau berdampingan), atau pratinjau penuh.
- **Mode fokus** (`Ctrl Shift F`) — sembunyikan panel samping untuk menulis tanpa gangguan.
- **Markdown kaya** — judul, tebal/miring, kode, kutipan, tautan, tabel, callout, `==sorot==`, dan checklist.
- **Wikilink `[[Judul catatan]]`** — hubungkan catatan; klik tautan di pratinjau untuk membuka atau membuat catatan tujuan.
- **Riwayat versi** — snapshot otomatis saat menulis (maksimal 20 versi), bisa dipulihkan kapan saja.
- **Insight** — streak menulis, peta aktivitas 6 minggu, progres tugas, buku catatan dan tag teratas.
- **Templat** — rapat, jurnal harian, rencana proyek, checklist, riset, dan review mingguan.
- **Catatan harian** (`Ctrl Shift D`) — buka atau buat jurnal hari ini secara otomatis.
- **Checklist tugas** — tulis `- [ ] ...`, lalu selesaikan dari menu **Tugas** yang menggabungkan tugas dari semua catatan.
- **Buku catatan & tag** — kelompokkan pekerjaan, lalu filter dengan satu klik.
- **Cari cepat** — mencari di judul, isi, tag, dan nama buku catatan.
- **Sematkan** catatan penting agar selalu di atas.
- **Arsip & Sampah** — sampah menyimpan catatan 30 hari sebelum dibersihkan otomatis.
- **Cetak / PDF** — cetak catatan atau simpan sebagai PDF dari menu aksi.
- **Ekspor/Impor JSON** — cadangan penuh (termasuk riwayat versi), plus unduh satu catatan sebagai `.md`.
  Di APK, hasil ekspor tersimpan di `Download/Catatan/`.
- **PWA** — bisa dipasang ke layar utama, punya pintasan "Catatan baru" dan "Harian", tetap terbuka saat offline.
- **Tema neo brutalism** terang/gelap, tata letak responsif untuk HP maupun desktop.

## Menjalankan versi web di Termux

```bash
cd ~/catatan
./serve.sh             # default port 8080
```

Buka **http://localhost:8080** di Chrome.

Port lain:

```bash
./serve.sh 9000
```

> Service worker dan pemasangan PWA memerlukan `http://localhost` atau `https://`.
> Membuka `index.html` langsung lewat `file://` masih bisa dipakai, tetapi tanpa
> cache offline dan tanpa tombol pasang.

1. Jalankan server seperti di atas, buka alamatnya di Chrome Android.
2. Menu ⋮ → **Tambahkan ke layar utama** / **Instal aplikasi**.
3. Bisa juga lewat tombol **Pasang** di panel kiri bila muncul.

## Membangun APK

### A. GitHub Actions (tanpa komputer)

Setiap push ke `main` dan setiap tag `v*` akan membangun APK lewat
`.github/workflows/android.yml`. Hasilnya ada di tab **Actions** (artifact
`catatan-apk`), dan otomatis dilampirkan ke rilis bila kamu push tag:

```bash
git tag v1.1.0 && git push origin v1.1.0
```

### B. Termux (tanpa Gradle, cara yang dipakai untuk rilis ini)

```bash
pkg install openjdk-17 aapt2 apksigner dx
cd ~/catatan
./android/build-termux.sh
# hasil: android/build/Catatan-1.1.0.apk
```

Skrip mengunduh `android.jar` (platform 34) sekali ke `~/build/sdk`, lalu memanggil
`aapt2`, `javac`, `dx`, `zipalign.py` (pengganti zipalign untuk aarch64), dan
`apksigner`. Versi bisa diatur lewat `VERSION_NAME=1.1.0 VERSION_CODE=3 ./android/build-termux.sh`.

### C. Gradle biasa

```bash
cd android
gradle assembleRelease
# android/app/build/outputs/apk/release/app-release.apk
```

Aset web di akar repo disalin otomatis ke `assets/www` saat build.

> **Catatan keystore:** `android/release.keystore` (password & alias: `catatan`)
> disertakan agar APK dari Termux, Gradle, dan CI memakai tanda tangan yang sama
> sehingga bisa saling memperbarui. Ini kunci publik untuk proyek ini — jangan
> dipakai untuk aplikasi yang butuh keamanan nyata.

## Pintasan

| Tombol | Fungsi |
| --- | --- |
| `Ctrl K` | Command palette: cari catatan / jalankan perintah |
| `Ctrl N` | Catatan baru |
| `Ctrl Shift D` | Catatan harian hari ini |
| `Ctrl E` | Ganti mode editor: tulis → pisah → pratinjau |
| `Ctrl Shift F` | Mode fokus |
| `Ctrl S` | Paksa simpan sekarang |
| `/` | Fokus ke pencarian |
| `?` | Daftar pintasan & sintaks |
| `Esc` / tombol kembali | Tutup dialog / keluar mode fokus / kembali dari editor (HP) |

## Markdown singkat

```markdown
# Judul bagian
**tebal**  *miring*  `kode`  ~~coret~~  ==sorot==

- poin daftar
- [ ] tugas belum selesai
- [x] tugas selesai

> kutipan biasa

> [!NOTE] Judul callout
> Isi catatan penting. Varian: NOTE, TIP, WARN, DANGER.

| Kolom | Nilai |
| --- | --- |
| Baris | Isi |

[[Judul catatan lain]]        tautan internal
[teks tautan](https://contoh.com)
```

## Tentang penyimpanan data

- Di **APK**, data disimpan di penyimpanan lokal aplikasi (localStorage WebView) —
  tidak ada akses internet sama sekali.
- Di **browser/PWA**, data disimpan di IndexedDB perangkat, dengan cadangan otomatis
  ke `localStorage` bila IndexedDB tidak tersedia.
- **Riwayat versi** ikut tersimpan di dalam catatan (maksimal 20 versi) dan ikut
  masuk ke berkas ekspor JSON.
- **Jangan hapus data aplikasi** di Setelan Android, karena catatan ikut terhapus.
- Lakukan **Ekspor** berkala (panel kiri bawah) untuk menyimpan cadangan `.json`.
- Memindahkan data ke perangkat lain: **Ekspor** di perangkat lama → salin berkas →
  **Impor** di perangkat baru.

## Struktur berkas

```
catatan/
├── index.html                 # kerangka aplikasi
├── assets/
│   ├── app.js                 # logika: penyimpanan, markdown, UI
│   └── styles.css             # tema terang/gelap + tata letak
├── manifest.webmanifest       # metadata PWA
├── sw.js                      # cache offline
├── icon-192.png
├── icon-512.png
├── icon-maskable-512.png
├── icon.svg
├── serve.sh                   # server lokal (Python)
├── android/
│   ├── app/src/main/
│   │   ├── AndroidManifest.xml
│   │   ├── java/id/catatan/app/MainActivity.java   # WebView + jembatan berkas
│   │   └── res/                                     # ikon & tema
│   ├── tools/zipalign.py
│   ├── build-termux.sh        # build APK langsung dari Termux
│   ├── build.gradle
│   └── release.keystore
└── .github/workflows/android.yml
```

## Menyesuaikan

- **Warna aksen**: ubah `--accent` / `--accent-2` di `assets/styles.css` (`:root` dan `[data-theme="dark"]`).
- **Catatan sambutan**: sunting `maybeSeed()` di `assets/app.js`.
- **Nama aplikasi**: `android/app/src/main/res/values/strings.xml` dan `android/app/build.gradle`.
- **Versi**: `versionCode` / `versionName` di `android/app/build.gradle`, atau env
  `VERSION_CODE` / `VERSION_NAME` saat memakai `build-termux.sh`.
