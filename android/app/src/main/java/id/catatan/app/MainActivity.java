package id.catatan.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * Pembungkus Android untuk aplikasi Catatan.
 *
 * Seluruh antarmuka berasal dari berkas web di assets/www dan dimuat lewat
 * file:// sehingga aplikasi berjalan 100% offline tanpa izin jaringan.
 * Jembatan CatatanAndroid dipakai untuk menyimpan ekspor ke folder Download.
 */
public class MainActivity extends Activity {

    private static final String START_URL = "file:///android_asset/www/index.html";
    private static final int REQ_IMPORT = 1001;
    private static final int REQ_WRITE = 1002;
    private static final String BG = "#f7f4ec";

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    // Antrean satu berkas untuk kasus izin tulis (Android 6-9).
    private String pendingName;
    private String pendingMime;
    private byte[] pendingData;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor(BG));
        getWindow().setNavigationBarColor(Color.parseColor(BG));
        if (Build.VERSION.SDK_INT >= 23) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor(BG));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.addJavascriptInterface(new Bridge(), "CatatanAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        setContentView(web);
        web.loadUrl(START_URL);
    }

    /* ---------------- jembatan JS ---------------- */

    private class Bridge {
        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public String version() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "1.0";
            }
        }

        @JavascriptInterface
        public void saveFile(String name, String mime, String base64) {
            byte[] data;
            try {
                data = Base64.decode(base64, Base64.DEFAULT);
            } catch (Exception e) {
                toastOnUi("Gagal menyiapkan berkas");
                return;
            }
            final String safeName = safeFileName(name);
            final String safeMime = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime.split(";")[0];
            final byte[] payload = data;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    saveBytes(safeName, safeMime, payload);
                }
            });
        }

        @JavascriptInterface
        public void toast(String message) {
            toastOnUi(message);
        }

        @JavascriptInterface
        public void print(final String title) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    printDocument(title);
                }
            });
        }
    }

    /* ---------------- pencetakan / ekspor PDF ---------------- */

    private void printDocument(String title) {
        if (web == null) return;
        try {
            PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
            if (printManager == null) {
                toastOnUi("Layanan cetak tidak tersedia di perangkat ini");
                return;
            }
            String safeTitle = (title == null || title.trim().isEmpty()) ? "Catatan" : title.trim();
            final String jobName = "Catatan - " + safeTitle;
            final PrintDocumentAdapter delegate = web.createPrintDocumentAdapter(jobName);
            PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
                @Override
                public void onStart() {
                    delegate.onStart();
                }

                @Override
                public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes,
                                     CancellationSignal cancellationSignal, LayoutResultCallback callback,
                                     Bundle extras) {
                    delegate.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras);
                }

                @Override
                public void onWrite(PageRange[] pages, ParcelFileDescriptor destination,
                                    CancellationSignal cancellationSignal, WriteResultCallback callback) {
                    delegate.onWrite(pages, destination, cancellationSignal, callback);
                }

                @Override
                public void onFinish() {
                    delegate.onFinish();
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (web != null) {
                                web.evaluateJavascript("if(typeof window.onPrintDone==='function'){window.onPrintDone();}", null);
                            }
                        }
                    });
                }
            };
            printManager.print(jobName, adapter, new PrintAttributes.Builder().build());
        } catch (Exception e) {
            toastOnUi("Gagal membuka dialog cetak: " + e.getMessage());
        }
    }

    private void toastOnUi(final String message) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show();
            }
        });
    }

    private static String safeFileName(String name) {
        String cleaned = (name == null || name.trim().isEmpty()) ? "catatan" : name.trim();
        cleaned = cleaned.replaceAll("[\\\\/:*?\"<>|]+", "-");
        return cleaned.length() > 120 ? cleaned.substring(0, 120) : cleaned;
    }

    /* ---------------- penyimpanan berkas ---------------- */

    private void saveBytes(String name, String mime, byte[] data) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveWithMediaStore(name, mime, data);
                return;
            }
            if (checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                pendingName = name;
                pendingMime = mime;
                pendingData = data;
                requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_WRITE);
                return;
            }
            saveLegacy(name, data);
        } catch (Exception e) {
            toastOnUi("Gagal menyimpan: " + e.getMessage());
        }
    }

    @android.annotation.TargetApi(Build.VERSION_CODES.Q)
    private void saveWithMediaStore(String name, String mime, byte[] data) throws IOException {
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Catatan");
        Uri item = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (item == null) throw new IOException("folder Download tidak tersedia");
        OutputStream out = getContentResolver().openOutputStream(item);
        if (out == null) throw new IOException("berkas tidak bisa dibuka");
        try {
            out.write(data);
            out.flush();
        } finally {
            out.close();
        }
        toastOnUi("Tersimpan di Download/Catatan/" + name);
    }

    private void saveLegacy(String name, byte[] data) throws IOException {
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Catatan");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("folder Download tidak bisa dibuat");
        File file = uniqueFile(dir, name);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
        MediaScannerConnection.scanFile(this, new String[]{file.getAbsolutePath()}, null, null);
        toastOnUi("Tersimpan di Download/Catatan/" + file.getName());
    }

    private static File uniqueFile(File dir, String name) {
        File file = new File(dir, name);
        if (!file.exists()) return file;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; i < 1000; i++) {
            File candidate = new File(dir, base + " (" + i + ")" + ext);
            if (!candidate.exists()) return candidate;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_WRITE) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted && pendingData != null) {
            try {
                saveLegacy(pendingName, pendingData);
            } catch (Exception e) {
                toastOnUi("Gagal menyimpan: " + e.getMessage());
            }
        } else {
            toastOnUi("Izin penyimpanan ditolak — ekspor dibatalkan");
        }
        pendingName = null;
        pendingMime = null;
        pendingData = null;
    }

    /* ---------------- pemilih berkas (impor) ---------------- */

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            try {
                startActivityForResult(Intent.createChooser(intent, "Pilih cadangan Catatan"), REQ_IMPORT);
            } catch (Exception e) {
                fileCallback = null;
                toastOnUi("Tidak ada aplikasi berkas");
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_IMPORT) return;
        if (fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            result = new Uri[]{data.getData()};
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    /* ---------------- navigasi ---------------- */

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null) return false;
            String scheme = uri.getScheme() == null ? "" : uri.getScheme();
            boolean internal = "file".equals(scheme) && "android_asset".equals(uri.getAuthority());
            if (internal) return false;
            if ("http".equals(scheme) || "https".equals(scheme) || "mailto".equals(scheme) || "tel".equals(scheme)) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception e) {
                    toastOnUi("Tautan tidak bisa dibuka");
                }
                return true;
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                view.loadDataWithBaseURL(null,
                        "<html><body style=\"font-family:sans-serif;padding:32px;background:#f7f4ec;color:#1b1b1b\">"
                                + "<h2>Aset aplikasi tidak terbaca</h2>"
                                + "<p>Pasang ulang APK Catatan, lalu buka kembali.</p>"
                                + "</body></html>",
                        "text/html", "utf-8", null);
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        // Di dalam editor, tombol kembali menutup editor lebih dulu.
        web.evaluateJavascript(
                "(function(){var b=document.getElementById('backBtn');"
                        + "if(b&&b.offsetParent!==null){b.click();return '1';}return '0';})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if ("\"1\"".equals(value)) return;
                        if (web != null && web.canGoBack()) web.goBack();
                        else finish();
                    }
                });
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.evaluateJavascript("try{flushSave()}catch(e){}", null);
            web.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
