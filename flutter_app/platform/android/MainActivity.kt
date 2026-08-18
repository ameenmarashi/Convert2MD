package com.marashi.md_converter

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Receives documents Android hands to the app and forwards them to Dart.
 *
 * Registered for ACTION_VIEW (the "Open with" sheet, and tapping a .md in
 * Files, Drive or a file manager) and ACTION_SEND (the share sheet). The
 * matching intent filters are in AndroidManifest.xml.
 *
 * Copied into android/app/src/main/kotlin/... by tool/configure_platforms.sh.
 * The Dart half is lib/src/platform/opened_files.dart.
 */
class MainActivity : FlutterActivity() {
    private companion object {
        const val CHANNEL = "md_converter/opened_files"

        /** A document the app will not try to hold in memory. */
        const val MAX_BYTES = 200L * 1024 * 1024
    }

    private var channel: MethodChannel? = null

    /** Held for the launch intent, which arrives before Dart can ask for it. */
    private var pending: List<Map<String, Any?>> = emptyList()

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        pending = filesFrom(intent)
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).apply {
            setMethodCallHandler { call, result ->
                if (call.method == "getInitialFiles") {
                    result.success(pending)
                    pending = emptyList()
                } else {
                    result.notImplemented()
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)

        val files = filesFrom(intent)
        if (files.isEmpty()) return

        val open = channel
        if (open == null) pending = files else open.invokeMethod("onFilesOpened", files)
    }

    private fun filesFrom(intent: Intent?): List<Map<String, Any?>> {
        if (intent == null) return emptyList()

        val uris: List<Uri> = when (intent.action) {
            Intent.ACTION_VIEW -> listOfNotNull(intent.data)
            Intent.ACTION_SEND -> listOfNotNull(streamExtra(intent))
            Intent.ACTION_SEND_MULTIPLE -> streamExtras(intent)
            else -> emptyList()
        }
        return uris.mapNotNull { read(it) }
    }

    @Suppress("DEPRECATION")
    private fun streamExtra(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }

    @Suppress("DEPRECATION")
    private fun streamExtras(intent: Intent): List<Uri> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
        } else {
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
        }

    /**
     * A content: URI has no readable path, so the bytes are read here and sent
     * over the channel. The display name comes from the provider, falling back
     * to the last path segment.
     */
    private fun read(uri: Uri): Map<String, Any?>? {
        return try {
            val bytes = contentResolver.openInputStream(uri)?.use { stream ->
                // One document that will not fit in memory is not worth an OOM.
                if (stream.available() > MAX_BYTES) return null
                stream.readBytes()
            } ?: return null

            mapOf("name" to displayName(uri), "bytes" to bytes)
        } catch (error: Exception) {
            null
        }
    }

    private fun displayName(uri: Uri): String {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (column >= 0 && cursor.moveToFirst()) {
                    cursor.getString(column)?.let { return it }
                }
            }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "document"
    }
}
