package app.mavyn.files

import java.net.URI
import java.security.MessageDigest
import java.util.Locale

class SafFailure(val code: String) : Exception(code)

object SafPolicy {
    const val MAX_BYTES = 16 * 1024 * 1024

    fun exportMime(name: String): String = when (name.substringAfterLast('.').lowercase(Locale.ROOT)) {
        "md", "markdown", "mdown", "mkd", "mdx" -> "text/markdown"
        "txt" -> "text/plain"
        "html", "htm" -> "text/html"
        "svg" -> "image/svg+xml"
        else -> "application/octet-stream"
    }

    fun hash(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

    fun requireHash(bytes: ByteArray, expected: String) {
        if (hash(bytes) != expected) throw SafFailure("file.external_change")
    }

    fun requireSize(size: Long) {
        if (size > MAX_BYTES) throw SafFailure("file.unsupported")
    }

    fun requireName(name: String) {
        if (!listOf(".md", ".markdown", ".mdown", ".mkd", ".mdx", ".txt")
                .any { name.lowercase(Locale.ROOT).endsWith(it) }) throw SafFailure("file.unsupported")
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
