package app.mavyn.files

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.system.Os
import android.system.OsConstants
import android.util.Base64
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.util.concurrent.Executors

@InvokeArg class PickArgs { var multiple: Boolean = false; var link: Boolean = false }
@InvokeArg class LocatorArgs { lateinit var locator: String }
@InvokeArg class FingerprintArgs { lateinit var contentHash: String }
@InvokeArg class WriteArgs {
    lateinit var locator: String
    lateinit var bytesBase64: String
    lateinit var expected: FingerprintArgs
}
@InvokeArg class SaveArgs { lateinit var name: String; lateinit var bytesBase64: String }

@TauriPlugin
class MavynFilesPlugin(private val activity: Activity) : Plugin(activity) {
    private val resolver get() = activity.contentResolver
    private val preferences = activity.getSharedPreferences("mavyn-saf", Activity.MODE_PRIVATE)
    private val io = Executors.newSingleThreadExecutor()
    private var pickerBusy = false

    private fun answer(invoke: Invoke, action: () -> Any) {
        try { invoke.resolve(JSObject().put("value", action())) }
        catch (error: Exception) {
            val code = when (error) {
                is SafFailure -> error.code
                is SecurityException -> "file.permission_denied"
                is FileNotFoundException -> "file.not_found"
                else -> "storage.failed"
            }
            invoke.resolve(JSObject().put("error", code))
        }
    }

    private fun read(uri: Uri): ByteArray = resolver.openInputStream(uri)?.use { input ->
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            SafPolicy.requireSize(out.size().toLong() + count)
            out.write(buffer, 0, count)
        }
        out.toByteArray()
    } ?: throw FileNotFoundException()

    private fun name(uri: Uri): String = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst()) it.getString(0) else null
    } ?: "document.md"

    private fun fingerprint(uri: Uri, bytes: ByteArray): JSObject {
        val modified = resolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_LAST_MODIFIED), null, null, null)?.use {
            if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else 0L
        } ?: 0L
        return JSObject().put("size", bytes.size).put("modifiedMs", modified).put("contentHash", SafPolicy.hash(bytes))
    }

    private fun checkedUri(locator: String): Uri {
        val uri = Uri.parse(locator)
        val grant = resolver.persistedUriPermissions.find { it.uri == uri }
        SafPolicy.requireAccess(locator, preferences.getStringSet("allowed", emptySet())!!.contains(locator),
            grant?.isReadPermission == true, grant?.isWritePermission == true)
        return uri
    }

    @Command fun pickFiles(invoke: Invoke) {
        if (pickerBusy) { answer(invoke) { throw SafFailure("storage.busy") }; return }
        val args = invoke.parseArgs(PickArgs::class.java)
        pickerBusy = true
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.multiple)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (args.link) addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        try { startActivityForResult(invoke, intent, "picked") }
        catch (error: Exception) { pickerBusy = false; answer(invoke) { throw error } }
    }

    @ActivityCallback fun picked(invoke: Invoke, result: ActivityResult) {
        pickerBusy = false
        io.execute { answer(invoke) {
            if (result.resultCode == Activity.RESULT_CANCELED) return@answer JSArray()
            if (result.resultCode != Activity.RESULT_OK) throw SafFailure("storage.failed")
            val data = result.data ?: throw SafFailure("storage.failed")
            val args = invoke.parseArgs(PickArgs::class.java)
            val uris = data.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } }
                ?: listOfNotNull(data.data)
            val files = JSArray()
            for (uri in uris.distinct()) {
                if (uri.scheme != "content") throw SafFailure("file.unsupported")
                val fileName = name(uri)
                SafPolicy.requireName(fileName)
                val bytes = read(uri)
                if (args.link) {
                    val flags = data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    if (flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION == 0) throw SafFailure("file.permission_denied")
                    resolver.takePersistableUriPermission(uri, flags)
                    val allowed = preferences.getStringSet("allowed", emptySet())!!.toMutableSet()
                    allowed.add(uri.toString())
                    if (!preferences.edit().putStringSet("allowed", allowed).commit()) throw SafFailure("storage.failed")
                    checkedUri(uri.toString())
                }
                files.put(JSObject().put("name", fileName).put("locator", uri.toString())
                    .put("bytesBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    .put("fingerprint", fingerprint(uri, bytes)))
            }
            files
        } }
    }

    @Command fun readLinked(invoke: Invoke) { io.execute { answer(invoke) {
        val uri = checkedUri(invoke.parseArgs(LocatorArgs::class.java).locator)
        val bytes = read(uri)
        JSObject().put("bytesBase64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("fingerprint", fingerprint(uri, bytes))
    } } }

    @Command fun writeLinked(invoke: Invoke) { io.execute { answer(invoke) {
        val args = invoke.parseArgs(WriteArgs::class.java)
        val uri = checkedUri(args.locator)
        val bytes = Base64.decode(args.bytesBase64, Base64.NO_WRAP)
        SafPolicy.requireSize(bytes.size.toLong())
        SafPolicy.requireHash(read(uri), args.expected.contentHash)
        // "rw" does not truncate. Reject streams/pipes before touching their content.
        resolver.openFileDescriptor(uri, "rw")?.use { descriptor ->
            val fd = descriptor.fileDescriptor
            val current = ByteArrayOutputStream()
            try {
                if (!OsConstants.S_ISREG(Os.fstat(fd).st_mode)) throw SafFailure("file.write_unsupported")
                Os.lseek(fd, 0, OsConstants.SEEK_SET)
                val buffer = ByteArray(8192)
                while (true) {
                    val count = Os.read(fd, buffer, 0, buffer.size)
                    if (count == 0) break
                    SafPolicy.requireSize(current.size().toLong() + count)
                    current.write(buffer, 0, count)
                }
                SafPolicy.requireHash(current.toByteArray(), args.expected.contentHash)
                // Verify truncation support at the unchanged length before the first write.
                Os.ftruncate(fd, current.size().toLong())
                Os.lseek(fd, 0, OsConstants.SEEK_SET)
            } catch (error: android.system.ErrnoException) { throw SafFailure("file.write_unsupported") }
            var offset = 0
            while (offset < bytes.size) {
                val written = Os.write(fd, bytes, offset, bytes.size - offset)
                if (written <= 0) throw SafFailure("storage.failed")
                offset += written
            }
            Os.ftruncate(fd, bytes.size.toLong())
            Os.fsync(fd)
        } ?: throw FileNotFoundException()
        val saved = read(uri)
        if (!saved.contentEquals(bytes)) throw SafFailure("storage.failed")
        fingerprint(uri, saved)
    } } }

    @Command fun saveAs(invoke: Invoke) {
        if (pickerBusy) { answer(invoke) { throw SafFailure("storage.busy") }; return }
        val args = invoke.parseArgs(SaveArgs::class.java)
        pickerBusy = true
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = SafPolicy.exportMime(args.name)
            putExtra(Intent.EXTRA_TITLE, args.name.substringAfterLast('/').substringAfterLast('\\'))
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        try { startActivityForResult(invoke, intent, "created") }
        catch (error: Exception) { pickerBusy = false; answer(invoke) { throw error } }
    }

    @ActivityCallback fun created(invoke: Invoke, result: ActivityResult) {
        pickerBusy = false
        io.execute { answer(invoke) {
            if (result.resultCode == Activity.RESULT_CANCELED) return@answer false
            if (result.resultCode != Activity.RESULT_OK) throw SafFailure("storage.failed")
            val uri = result.data?.data ?: throw SafFailure("storage.failed")
            if (uri.scheme != "content") throw SafFailure("file.unsupported")
            val bytes = Base64.decode(invoke.parseArgs(SaveArgs::class.java).bytesBase64, Base64.NO_WRAP)
            SafPolicy.requireSize(bytes.size.toLong())
            resolver.openFileDescriptor(uri, "wt")?.use { descriptor ->
                ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { it.write(bytes); it.flush() }
            } ?: throw FileNotFoundException()
            true
        } }
    }
}
