package app.mavyn.files

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Called only on the plugin IO executor. Neither plaintext nor AES keys enter JS storage. */
class SecureSessions(private val root: File) {
    private val alias = "app.mavyn.sync.v1"
    private fun file(key: String): AtomicFile {
        if (!Regex("[0-9a-f]{64}").matches(key)) throw SafFailure("storage.failed")
        if (!root.isDirectory && !root.mkdirs()) throw SafFailure("storage.failed")
        return AtomicFile(File(root, key))
    }
    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun read(key: String): String? {
        val file = file(key)
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return null
        if (file.baseFile.length() > 16384) { file.delete(); return null }
        val bytes = file.readFully()
        val secret = store().getKey(alias, null) as? SecretKey
        if (secret == null || bytes.size !in 30..16384 || bytes[0] != 1.toByte()) { file.delete(); return null }
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
            cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
            String(cipher.doFinal(bytes.copyOfRange(13, bytes.size)), Charsets.UTF_8)
        } catch (error: java.security.GeneralSecurityException) { file.delete(); null }
    }

    fun write(key: String, value: String) {
        if (value.isEmpty() || value.length > 8192) throw SafFailure("storage.failed")
        val file = file(key)
        val secret = store().getKey(alias, null) as? SecretKey ?: KeyGenerator.getInstance("AES", "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setUserAuthenticationRequired(false).build())
        }.generateKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secret)
        cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
        val bytes = byteArrayOf(1) + cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val output = file.startWrite()
        try { output.write(bytes); file.finishWrite(output) }
        catch (error: Exception) { file.failWrite(output); throw error }
    }

    fun delete(key: String) {
        val file = file(key)
        file.delete()
        if (file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()) throw SafFailure("storage.failed")
    }
}
