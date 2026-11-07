use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

/// Argon2id with OWASP-recommended minimum parameters (19 MiB, t=2, p=1).
fn argon2() -> Argon2<'static> {
    #[allow(clippy::unwrap_used)] // Constant, valid parameters.
    let params = Params::new(19 * 1024, 2, 1, None).unwrap();
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

pub fn hash_password(password: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut OsRng);
    Ok(argon2().hash_password(password.as_bytes(), &salt)?.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|parsed| argon2().verify_password(password.as_bytes(), &parsed).is_ok())
}

/// A hash to verify against when the user does not exist, so timing does not reveal usernames.
pub fn dummy_hash() -> &'static str {
    use std::sync::OnceLock;
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_password("not-a-real-password-0000").unwrap_or_default())
}

/// 256-bit random token, URL-safe base64.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    #[allow(clippy::unwrap_used)] // The OS RNG failing is unrecoverable.
    getrandom::fill(&mut bytes).unwrap();
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn sha256(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).to_vec()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Constant-time comparison for secrets of equal length.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Case-insensitive key for usernames: NFC + lowercase.
pub fn username_key(username: &str) -> String {
    username.nfc().collect::<String>().to_lowercase()
}

pub fn valid_username(username: &str) -> bool {
    let len = username.chars().count();
    (3..=64).contains(&len) && username.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Minimum policy: length. Passphrases are encouraged; composition rules are not enforced (NIST 800-63B).
pub fn valid_password(password: &str) -> bool {
    (10..=1024).contains(&password.chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_round_trip() {
        let hash = hash_password("correct horse battery").expect("hash");
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password("correct horse battery", &hash));
        assert!(!verify_password("wrong", &hash));
        assert!(!verify_password("x", "not a hash"));
    }

    #[test]
    fn usernames() {
        assert_eq!(username_key("Иван"), username_key("иван"));
        assert!(valid_username("иван.петров"));
        assert!(!valid_username("a b"));
        assert!(!valid_username("ab"));
    }

    #[test]
    fn tokens_are_random() {
        assert_ne!(random_token(), random_token());
        assert_eq!(random_token().len(), 43);
    }
}
