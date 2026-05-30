use codex_protocol::models::PermissionProfile;
use std::path::Path;
use thiserror::Error;

/// Basename used when the Codex executable self-invokes as the Linux sandbox
/// helper.
pub const CODEX_LINUX_SANDBOX_ARG0: &str = "codex-linux-sandbox";

/// Errors that can occur when creating Linux sandbox command arguments.
#[derive(Debug, Error)]
pub enum LandlockError {
    #[error("failed to serialize permission profile: {0}")]
    SerializationError(#[from] serde_json::Error),
    #[error("path contains invalid UTF-8: {path}")]
    InvalidUtf8Path { path: String },
}

pub fn allow_network_for_proxy(enforce_managed_network: bool) -> bool {
    // When managed network requirements are active, request proxy-only
    // networking from the Linux sandbox helper. Without managed requirements,
    // preserve existing behavior.
    enforce_managed_network
}

/// Converts the permission profile into the CLI invocation for
/// `codex-linux-sandbox`.
///
/// The helper performs the actual sandboxing (bubblewrap by default + seccomp)
/// after parsing these arguments. The profile JSON flag is emitted before
/// helper feature flags so the argv order matches the helper's CLI shape. See
/// `docs/linux_sandbox.md` for the Linux semantics.
///
/// # Errors
///
/// Returns an error if the permission profile cannot be serialized or if any
/// path contains invalid UTF-8 characters.
#[allow(clippy::too_many_arguments)]
pub fn create_linux_sandbox_command_args_for_permission_profile(
    command: Vec<String>,
    command_cwd: &Path,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &Path,
    use_legacy_landlock: bool,
    allow_network_for_proxy: bool,
) -> Result<Vec<String>, LandlockError> {
    let permission_profile_json = serde_json::to_string(permission_profile)?;
    let sandbox_policy_cwd = sandbox_policy_cwd
        .to_str()
        .ok_or_else(|| LandlockError::InvalidUtf8Path {
            path: sandbox_policy_cwd.to_string_lossy().into_owned(),
        })?
        .to_string();
    let command_cwd = command_cwd
        .to_str()
        .ok_or_else(|| LandlockError::InvalidUtf8Path {
            path: command_cwd.to_string_lossy().into_owned(),
        })?
        .to_string();

    let mut linux_cmd: Vec<String> = vec![
        "--sandbox-policy-cwd".to_string(),
        sandbox_policy_cwd,
        "--command-cwd".to_string(),
        command_cwd,
        "--permission-profile".to_string(),
        permission_profile_json,
    ];
    if use_legacy_landlock {
        linux_cmd.push("--use-legacy-landlock".to_string());
    }
    if allow_network_for_proxy {
        linux_cmd.push("--allow-network-for-proxy".to_string());
    }
    linux_cmd.push("--".to_string());
    linux_cmd.extend(command);
    Ok(linux_cmd)
}

/// Converts the sandbox cwd and execution options into the CLI invocation for
/// `codex-linux-sandbox`.
///
/// # Errors
///
/// Returns an error if any path contains invalid UTF-8 characters.
#[cfg_attr(not(test), allow(dead_code))]
fn create_linux_sandbox_command_args(
    command: Vec<String>,
    command_cwd: &Path,
    sandbox_policy_cwd: &Path,
    use_legacy_landlock: bool,
    allow_network_for_proxy: bool,
) -> Result<Vec<String>, LandlockError> {
    let command_cwd = command_cwd
        .to_str()
        .ok_or_else(|| LandlockError::InvalidUtf8Path {
            path: command_cwd.to_string_lossy().into_owned(),
        })?
        .to_string();
    let sandbox_policy_cwd = sandbox_policy_cwd
        .to_str()
        .ok_or_else(|| LandlockError::InvalidUtf8Path {
            path: sandbox_policy_cwd.to_string_lossy().into_owned(),
        })?
        .to_string();

    let mut linux_cmd: Vec<String> = vec![
        "--sandbox-policy-cwd".to_string(),
        sandbox_policy_cwd,
        "--command-cwd".to_string(),
        command_cwd,
    ];
    if use_legacy_landlock {
        linux_cmd.push("--use-legacy-landlock".to_string());
    }
    if allow_network_for_proxy {
        linux_cmd.push("--allow-network-for-proxy".to_string());
    }

    // Separator so that command arguments starting with `-` are not parsed as
    // options of the helper itself.
    linux_cmd.push("--".to_string());

    // Append the original tool command.
    linux_cmd.extend(command);

    Ok(linux_cmd)
}

#[cfg(test)]
#[path = "landlock_tests.rs"]
mod tests;
