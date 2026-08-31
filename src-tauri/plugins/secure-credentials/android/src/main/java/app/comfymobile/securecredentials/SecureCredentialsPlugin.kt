package app.comfymobile.securecredentials

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val ANDROID_KEY_STORE = "AndroidKeyStore"
private const val KEY_ALIAS = "comfy_mobile_gateway_credentials_v1"
private const val PREFERENCES_NAME = "comfy_mobile_secure_credentials_v1"
private const val TRANSFORMATION = "AES/GCM/NoPadding"

@InvokeArg
class SecretKeyArgs {
    lateinit var key: String
}

@InvokeArg
class SetSecretArgs {
    lateinit var key: String
    lateinit var value: String
}

@TauriPlugin
class SecureCredentialsPlugin(private val activity: Activity) : Plugin(activity) {
    private val validKey = Regex("^[A-Za-z0-9._:-]{1,128}$")
    private val preferences by lazy {
        activity.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    }

    @Command
    fun getSecret(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecretKeyArgs::class.java)
            requireValidKey(args.key)
            val encrypted = preferences.getString(args.key, null)
            val response = JSObject()
            if (encrypted != null) {
                response.put("value", decrypt(args.key, encrypted))
            }
            invoke.resolve(response)
        } catch (error: Exception) {
            invoke.reject("secure_credential_read_failed: ${safeMessage(error)}")
        }
    }

    @Command
    fun removeSecret(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecretKeyArgs::class.java)
            requireValidKey(args.key)
            if (!preferences.edit().remove(args.key).commit()) {
                throw IllegalStateException("credential removal was not persisted")
            }
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject("secure_credential_remove_failed: ${safeMessage(error)}")
        }
    }

    @Command
    fun setSecret(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SetSecretArgs::class.java)
            requireValidKey(args.key)
            val encrypted = encrypt(args.key, args.value)
            if (!preferences.edit().putString(args.key, encrypted).commit()) {
                throw IllegalStateException("credential update was not persisted")
            }
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject("secure_credential_write_failed: ${safeMessage(error)}")
        }
    }

    private fun requireValidKey(key: String) {
        require(validKey.matches(key)) { "invalid credential key" }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    private fun encrypt(key: String, value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        cipher.updateAAD(key.toByteArray(StandardCharsets.UTF_8))
        val ciphertext = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        val encodedIv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val encodedCiphertext = Base64.encodeToString(ciphertext, Base64.NO_WRAP)
        return "$encodedIv.$encodedCiphertext"
    }

    private fun decrypt(key: String, encrypted: String): String {
        val parts = encrypted.split('.', limit = 2)
        require(parts.size == 2) { "invalid encrypted credential" }
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        val ciphertext = Base64.decode(parts[1], Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        cipher.updateAAD(key.toByteArray(StandardCharsets.UTF_8))
        return String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
    }

    private fun safeMessage(error: Exception): String =
        error.message?.take(160) ?: error.javaClass.simpleName
}
