//! Domain types shared by the server and the native shell.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// Library roles, ordered by privilege (`Viewer < Editor < Admin < Owner`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Editor,
    Admin,
    Owner,
}

impl Role {
    pub const fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Editor => "editor",
            Role::Admin => "admin",
            Role::Owner => "owner",
        }
    }

    /// Whether this role may grant `target` to someone else. Only owners create owners.
    pub fn can_grant(self, target: Role) -> bool {
        match self {
            Role::Owner => true,
            Role::Admin => target < Role::Admin,
            _ => false,
        }
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Role {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "viewer" => Ok(Role::Viewer),
            "editor" => Ok(Role::Editor),
            "admin" => Ok(Role::Admin),
            "owner" => Ok(Role::Owner),
            _ => Err(()),
        }
    }
}

/// Stable machine-readable error codes. Clients map them to localized messages; the same codes
/// exist in `packages/core/src/errors.ts` and `packages/i18n` catalogs.
pub mod codes {
    pub const BAD_REQUEST: &str = "request.invalid";
    pub const TOO_LARGE: &str = "request.too_large";
    pub const ROUTE_NOT_FOUND: &str = "request.not_found";
    pub const RATE_LIMITED: &str = "request.rate_limited";
    pub const AUTH_REQUIRED: &str = "auth.required";
    pub const INVALID_CREDENTIALS: &str = "auth.invalid_credentials";
    pub const CSRF: &str = "auth.csrf_failed";
    pub const FORBIDDEN: &str = "auth.forbidden";
    pub const SETUP_DONE: &str = "setup.already_completed";
    pub const SETUP_TOKEN: &str = "setup.invalid_token";
    pub const WEAK_PASSWORD: &str = "user.weak_password";
    pub const INVALID_USERNAME: &str = "user.invalid_username";
    pub const USERNAME_TAKEN: &str = "user.username_taken";
    pub const USER_NOT_FOUND: &str = "user.not_found";
    pub const SESSION_NOT_FOUND: &str = "session.not_found";
    pub const LAST_OWNER: &str = "library.last_owner";
    pub const LIBRARY_NOT_FOUND: &str = "library.not_found";
    pub const DOCUMENT_NOT_FOUND: &str = "document.not_found";
    pub const CONFLICT: &str = "sync.conflict";
    pub const PROTOCOL: &str = "sync.protocol_unsupported";
    pub const INTERNAL: &str = "server.internal";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_are_ordered_by_privilege() {
        assert!(
            Role::Viewer < Role::Editor && Role::Editor < Role::Admin && Role::Admin < Role::Owner
        );
    }

    #[test]
    fn grant_rules() {
        assert!(Role::Owner.can_grant(Role::Owner));
        assert!(Role::Admin.can_grant(Role::Editor));
        assert!(!Role::Admin.can_grant(Role::Admin));
        assert!(!Role::Editor.can_grant(Role::Viewer));
    }

    #[test]
    fn round_trips_strings() {
        for role in [Role::Viewer, Role::Editor, Role::Admin, Role::Owner] {
            assert_eq!(role.as_str().parse::<Role>(), Ok(role));
        }
        assert!("root".parse::<Role>().is_err());
    }
}
