package app.mavyn.files

import java.net.URI
import java.security.MessageDigest
import java.util.Locale

class SafFailure(val code: String) : Exception(code)

object SafPolicy {
    /** Text documents of any kind (Markdown, plain text, code, logs); matches the server default. */
    const val MAX_BYTES = 256 * 1024 * 1024
    /** Binary documents (docx, xlsx, ods, pdf); matches `MAX_FILE_BYTES` in TS. */
    const val MAX_FILE_BYTES = 50 * 1024 * 1024
    private val FILE_EXTENSIONS = listOf(".docx", ".xlsx", ".ods", ".pdf")

    fun isBinaryName(name: String): Boolean = FILE_EXTENSIONS.any { name.lowercase(Locale.ROOT).endsWith(it) }

    /** Documents Mavyn only shows (PDF): never linked for writing. */
    fun isViewOnlyName(name: String): Boolean = name.lowercase(Locale.ROOT).endsWith(".pdf")

    /** Size bound for a file by name: binary documents may be larger than text. */
    fun maxBytes(name: String): Int = if (isBinaryName(name)) MAX_FILE_BYTES else MAX_BYTES

    fun exportMime(name: String): String = when (name.substringAfterLast('.').lowercase(Locale.ROOT)) {
        "md", "markdown", "mdown", "mkd", "mdx" -> "text/markdown"
        "txt", "log" -> "text/plain"
        "csv" -> "text/csv"
        "json" -> "application/json"
        "xml" -> "text/xml"
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        "ods" -> "application/vnd.oasis.opendocument.spreadsheet"
        "pdf" -> "application/pdf"
        "html", "htm" -> "text/html"
        "svg" -> "image/svg+xml"
        else -> "application/octet-stream"
    }

    fun hash(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

    fun requireHash(bytes: ByteArray, expected: String) {
        if (hash(bytes) != expected) throw SafFailure("file.external_change")
    }

    fun requireSize(size: Long, limit: Int = MAX_BYTES) {
        if (size > limit) throw SafFailure("file.too_large")
    }

    /** Any file name is accepted: the app decides by content whether it is text or a known document. */
    fun requireName(name: String) {
        if (name.isBlank() || name.length > 255 || name.contains('/') || name.contains('\\') || name.contains('\u0000')) {
            throw SafFailure("file.unsupported")
        }
    }

    fun requireAccess(locator: String, allowed: Boolean, read: Boolean, write: Boolean) {
        val contentUri = try { URI(locator).scheme == "content" } catch (_: Exception) { false }
        if (!contentUri || !allowed || !read || !write) throw SafFailure("file.permission_denied")
    }

    fun requireIncomingUri(locator: String, providerUid: Int?, ownUid: Int) {
        val uri = try { URI(locator) } catch (_: Exception) { throw SafFailure("file.permission_denied") }
        val authority = uri.rawAuthority ?: throw SafFailure("file.permission_denied")
        // ContentResolver interprets userId@authority; PackageManager does not. Reject
        // encoded/user-qualified authorities rather than resolving a different provider.
        if (uri.scheme != "content" || uri.rawUserInfo != null || authority.contains('%') || authority.contains(':') ||
            providerUid == null || providerUid == ownUid) throw SafFailure("file.permission_denied")
    }
}
