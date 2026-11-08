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
        rejected("file.unsupported") { SafPolicy.requireSize(SafPolicy.MAX_BYTES + 1L) }
        rejected("file.unsupported") { SafPolicy.requireName("picture.png") }
        SafPolicy.requireName("Заметка.MD")
        SafPolicy.requireName("notes.txt")
    }

    @Test fun exportsWithTheCorrectMimeTypeAndExtension() {
        assertEquals("text/markdown", SafPolicy.exportMime("Заметка.MD"))
        assertEquals("text/html", SafPolicy.exportMime("document.html"))
        assertEquals("image/svg+xml", SafPolicy.exportMime("diagram.svg"))
        assertEquals("application/octet-stream", SafPolicy.exportMime("attachment.bin"))
    }
}
