package app.mavyn.files

import java.io.File
import java.io.FileOutputStream
import java.util.UUID

data class IncomingFile(val id: String, val name: String, val bytes: ByteArray)

/** Private snapshots outlive the sender's temporary grant. All calls use the plugin IO executor. */
class IncomingStore(private val root: File) {
    companion object {
        const val MAX_ENTRIES = 32
        private const val MAX_TOTAL = 64L * 1024 * 1024
        private val ID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    }

    init {
        root.listFiles()?.filter { it.isDirectory && it.name.startsWith('.') && ID.matches(it.name.drop(1)) }
            ?.forEach { if (!it.deleteRecursively()) throw SafFailure("storage.failed") }
    }

    private fun entries() = root.listFiles()?.filter { it.isDirectory && ID.matches(it.name) }?.sortedBy { it.name } ?: emptyList()

    fun put(name: String, bytes: ByteArray): String {
        SafPolicy.requireName(name)
        SafPolicy.requireSize(bytes.size.toLong())
        try { Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)) }
        catch (error: java.nio.charset.CharacterCodingException) { throw SafFailure("file.not_utf8") }
        if (name.length > 255 || name.contains('/') || name.contains('\\') || name.contains('\u0000')) throw SafFailure("file.unsupported")
        val existing = entries()
        if (existing.size >= MAX_ENTRIES || existing.sumOf { File(it, "content").length() } + bytes.size > MAX_TOTAL) throw SafFailure("storage.busy")
        if (!root.isDirectory && !root.mkdirs()) throw SafFailure("storage.failed")
        // UUIDv7: timestamp + random 12 bits, RFC variant + random 62 bits.
        val random = UUID.randomUUID()
        val id = UUID((System.currentTimeMillis() shl 16) or 0x7000L or (random.mostSignificantBits and 0xfff), random.leastSignificantBits).toString()
        val pending = File(root, ".$id")
        if (!pending.mkdir()) throw SafFailure("storage.failed")
        try {
            FileOutputStream(File(pending, "name")).use { it.write(name.toByteArray(Charsets.UTF_8)); it.fd.sync() }
            FileOutputStream(File(pending, "content")).use { it.write(bytes); it.fd.sync() }
            if (!pending.renameTo(File(root, id))) throw SafFailure("storage.failed")
        } finally { if (pending.exists()) pending.deleteRecursively() }
        return id
    }

    fun peek(): IncomingFile? = entries().firstOrNull()?.let {
        val content = File(it, "content")
        SafPolicy.requireSize(content.length())
        IncomingFile(it.name, File(it, "name").readText(Charsets.UTF_8), content.readBytes())
    }

    fun ack(id: String) {
        if (ID.matches(id)) {
            val entry = File(root, id)
            if (entry.exists() && !entry.deleteRecursively()) throw SafFailure("storage.failed")
        }
    }
}
