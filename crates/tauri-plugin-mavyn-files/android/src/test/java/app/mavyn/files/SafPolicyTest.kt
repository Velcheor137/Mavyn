package app.mavyn.files

import org.junit.Assert.*
import org.junit.Test

class SafPolicyTest {
    @Test fun incomingUrisCannotReadUnresolvedOrUserQualifiedPrivateProviders() {
        rejected("file.permission_denied") { SafPolicy.requireIncomingUri("content://0@app.mavyn.desktop.fileprovider/cache/a.md", null, 1000) }
        rejected("file.permission_denied") { SafPolicy.requireIncomingUri("content://0%40app.mavyn.desktop.fileprovider/cache/a.md", 2000, 1000) }
        rejected("file.permission_denied") { SafPolicy.requireIncomingUri("content://app.mavyn.desktop.fileprovider/cache/a.md", 1000, 1000) }
        rejected("file.permission_denied") { SafPolicy.requireIncomingUri("content://unresolved/a.md", null, 1000) }
        SafPolicy.requireIncomingUri("content://external.provider/a.md", 2000, 1000)
    }
    private fun rejected(code: String, action: () -> Unit) {
        try { action(); fail("Expected $code") } catch (error: SafFailure) { assertEquals(code, error.code) }
    }

    @Test fun rejectsUnpickedAndRevokedUris() {
        rejected("file.permission_denied") { SafPolicy.requireAccess("content://docs/a", false, true, true) }
        rejected("file.permission_denied") { SafPolicy.requireAccess("content://docs/a", true, false, true) }
        rejected("file.permission_denied") { SafPolicy.requireAccess("content://docs/a", true, true, false) }
        rejected("file.permission_denied") { SafPolicy.requireAccess("file:///sdcard/a.md", true, true, true) }
        SafPolicy.requireAccess("content://docs/a", true, true, true)
    }

    @Test fun rejectsEqualSizeExternalChangesBeforeWriting() {
        val before = "- [ ] Task\r\n".toByteArray()
        val external = "- [ ] Else\r\n".toByteArray()
        assertEquals(before.size, external.size)
        rejected("file.external_change") { SafPolicy.requireHash(external, SafPolicy.hash(before)) }
        SafPolicy.requireHash(before, SafPolicy.hash(before))
    }

    @Test fun boundsContentAndValidatesNames() {
        rejected("file.too_large") { SafPolicy.requireSize(SafPolicy.MAX_BYTES + 1L) }
        // Any text file name is fine (code, logs, no extension); the app checks the content.
        SafPolicy.requireName("Заметка.MD")
        SafPolicy.requireName("main.py")
        SafPolicy.requireName("Dockerfile")
        SafPolicy.requireName("Отчёт.PDF")
        rejected("file.unsupported") { SafPolicy.requireName(" ") }
        rejected("file.unsupported") { SafPolicy.requireName("a/b.txt") }
        rejected("file.unsupported") { SafPolicy.requireName("x".repeat(256)) }
    }

    @Test fun binaryDocumentsHaveTheirOwnSizeLimit() {
        assertEquals(SafPolicy.MAX_FILE_BYTES, SafPolicy.maxBytes("scan.pdf"))
        assertEquals(SafPolicy.MAX_BYTES, SafPolicy.maxBytes("note.md"))
        SafPolicy.requireSize(SafPolicy.MAX_FILE_BYTES.toLong(), SafPolicy.maxBytes("scan.pdf"))
        rejected("file.too_large") { SafPolicy.requireSize(SafPolicy.MAX_FILE_BYTES + 1L, SafPolicy.maxBytes("scan.pdf")) }
        assertTrue(SafPolicy.isBinaryName("a.ODS"))
        assertTrue(SafPolicy.isViewOnlyName("Скан.PDF"))
        assertFalse(SafPolicy.isViewOnlyName("table.xlsx"))
        assertFalse(SafPolicy.isBinaryName("a.md"))
    }

    @Test fun exportsWithTheCorrectMimeTypeAndExtension() {
        assertEquals("text/markdown", SafPolicy.exportMime("Заметка.MD"))
        assertEquals("text/html", SafPolicy.exportMime("document.html"))
        assertEquals("text/plain", SafPolicy.exportMime("server.log"))
        assertEquals("application/json", SafPolicy.exportMime("data.json"))
        assertEquals("application/pdf", SafPolicy.exportMime("Скан.pdf"))
        assertEquals("application/vnd.openxmlformats-officedocument.wordprocessingml.document", SafPolicy.exportMime("a.docx"))
        assertEquals("image/svg+xml", SafPolicy.exportMime("diagram.svg"))
        assertEquals("application/octet-stream", SafPolicy.exportMime("attachment.bin"))
    }
}
