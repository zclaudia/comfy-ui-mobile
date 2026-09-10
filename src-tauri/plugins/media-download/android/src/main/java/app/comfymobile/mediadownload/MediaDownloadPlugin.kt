package app.comfymobile.mediadownload

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.webkit.MimeTypeMap
import app.tauri.annotation.Command
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import androidx.activity.result.ActivityResult

@InvokeArg
class DownloadArgs {
    lateinit var url: String
    lateinit var filename: String
    var authorization: String? = null
    var mimeType: String? = null
}

@InvokeArg
class SaveJsonArgs {
    lateinit var filename: String
    lateinit var contents: String
}

@TauriPlugin
class MediaDownloadPlugin(private val activity: Activity) : Plugin(activity) {
    private var savingJson = false

    @Command
    fun saveJsonFile(invoke: Invoke) {
        if (savingJson) { invoke.reject("json_export_in_progress"); return }
        try {
            val args = invoke.parseArgs(SaveJsonArgs::class.java)
            val filename = sanitizeFilename(args.filename)
            require(filename.endsWith(".json", ignoreCase = true)) { "JSON filename required" }
            require(args.contents.toByteArray(Charsets.UTF_8).size <= 8 * 1024 * 1024) { "JSON export exceeds 8 MB" }
            savingJson = true
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/json"
                putExtra(Intent.EXTRA_TITLE, filename)
            }
            startActivityForResult(invoke, intent, "saveJsonResult")
        } catch (error: Exception) {
            savingJson = false
            invoke.reject("json_export_failed: ${safeMessage(error)}")
        }
    }

    @ActivityCallback
    private fun saveJsonResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            savingJson = false
            invoke.resolve(JSObject().put("saved", false))
            return
        }
        val uri = result.data?.data
        if (uri == null) { savingJson = false; invoke.reject("json_export_missing_destination"); return }
        // File providers may perform slow IO. Keep the WebView responsive while writing the selected document.
        Thread {
            try {
                val args = invoke.parseArgs(SaveJsonArgs::class.java)
                val bytes = args.contents.toByteArray(Charsets.UTF_8)
                require(bytes.size <= 8 * 1024 * 1024) { "JSON export exceeds 8 MB" }
                val stream = activity.contentResolver.openOutputStream(uri, "wt") ?: error("Cannot open destination")
                stream.use { it.write(bytes); it.flush() }
                activity.runOnUiThread { savingJson = false; invoke.resolve(JSObject().put("saved", true)) }
            } catch (error: Exception) {
                activity.runOnUiThread { savingJson = false; invoke.reject("json_export_failed: ${safeMessage(error)}") }
            }
        }.start()
    }

    @Command
    fun enqueueDownload(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(DownloadArgs::class.java)
            val uri = Uri.parse(args.url)
            require(uri.scheme == "http" || uri.scheme == "https") { "download URL must use HTTP or HTTPS" }

            val filename = sanitizeFilename(args.filename)
            val request = DownloadManager.Request(uri)
                .setTitle(filename)
                .setDescription("Downloaded by Comfy Mobile")
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(true)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)

            val mimeType = args.mimeType?.takeIf { it.isNotBlank() } ?: inferMimeType(filename)
            if (mimeType != null) request.setMimeType(mimeType)
            args.authorization?.takeIf { it.isNotBlank() }?.let {
                request.addRequestHeader("Authorization", it)
            }

            val manager = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val downloadId = manager.enqueue(request)
            val response = JSObject()
            response.put("downloadId", downloadId)
            response.put("filename", filename)
            invoke.resolve(response)
        } catch (error: Exception) {
            invoke.reject("media_download_enqueue_failed: ${safeMessage(error)}")
        }
    }

    private fun sanitizeFilename(value: String): String {
        val filename = value.substringAfterLast('/').substringAfterLast('\\').trim()
        require(filename.isNotEmpty() && filename != "." && filename != "..") { "invalid filename" }
        require(filename.length <= 180 && filename.none { it.code < 32 }) { "invalid filename" }
        return filename
    }

    private fun inferMimeType(filename: String): String? {
        val extension = filename.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
    }

    private fun safeMessage(error: Exception): String =
        error.message?.take(160) ?: error.javaClass.simpleName
}
