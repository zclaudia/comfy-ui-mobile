package app.comfymobile.mediadownload

import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.webkit.MimeTypeMap
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class DownloadArgs {
    lateinit var url: String
    lateinit var filename: String
    var authorization: String? = null
    var mimeType: String? = null
}

@TauriPlugin
class MediaDownloadPlugin(private val activity: Activity) : Plugin(activity) {
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
