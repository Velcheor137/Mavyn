package app.mavyn.files

import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class IncomingStoreTest {
    @Test fun rejectsInvalidUtf8AndRemovesOnlyInterruptedPrivateSnapshots() {
        val root = Files.createTempDirectory("mavyn-incoming").toFile()
        try {
            val interrupted = java.io.File(root, ".019a6110-0000-7000-8000-000000000001")
            interrupted.mkdir()
            java.io.File(interrupted, "content").writeText("partial")
            val unrelated = java.io.File(root, ".unrelated"); unrelated.mkdir()
            val store = IncomingStore(root)
            assertFalse(interrupted.exists())
            assertTrue(unrelated.exists())
            try { store.put("a.md", byteArrayOf(-1)); fail() }
            catch (error: SafFailure) { assertEquals("file.not_utf8", error.code) }
            assertNull(store.peek())
        } finally { root.deleteRecursively() }
    }
    @Test fun survivesRecreationUntilAcknowledgedWithoutChangingBytes() {
        val root = Files.createTempDirectory("mavyn-incoming").toFile()
        try {
            val bytes = byteArrayOf(-17, -69, -65, 35, 13, 10)
            val id = IncomingStore(root).put("ёж.md", bytes)
            val restored = IncomingStore(root)
            assertEquals(id, restored.peek()!!.id)
            assertEquals('7', id[14])
            assertEquals("ёж.md", restored.peek()!!.name)
            assertArrayEquals(bytes, restored.peek()!!.bytes)
            restored.ack("../../outside")
            assertNotNull(restored.peek())
            restored.ack(id)
            assertNull(IncomingStore(root).peek())
        } finally { root.deleteRecursively() }
    }

    @Test fun rejectsUnsupportedNamesAndBoundsPendingQueue() {
        val root = Files.createTempDirectory("mavyn-incoming").toFile()
        try {
            val store = IncomingStore(root)
            try { store.put("image.png", byteArrayOf()); fail() }
            catch (error: SafFailure) { assertEquals("file.unsupported", error.code) }
            repeat(IncomingStore.MAX_ENTRIES) { store.put("a.md", byteArrayOf(1)) }
            try { store.put("b.md", byteArrayOf(2)); fail() }
            catch (error: SafFailure) { assertEquals("storage.busy", error.code) }
            assertEquals(IncomingStore.MAX_ENTRIES, root.listFiles()!!.size)
        } finally { root.deleteRecursively() }
    }
}
