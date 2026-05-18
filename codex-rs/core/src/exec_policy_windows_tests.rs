use super::*;
use codex_protocol::config_types::WindowsSandboxLevel;
use pretty_assertions::assert_eq;
use std::path::Path;

#[tokio::test]
async fn evaluates_powershell_inner_commands_against_prompt_rules() {
    assert_exec_approval_requirement_for_command(
        ExecApprovalRequirementScenario {
            policy_src: Some(r#"prefix_rule(pattern=["echo"], decision="prompt")"#.to_string()),
            command: vec![
                "powershell.exe".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "echo blocked".to_string(),
            ],
            approval_policy: AskForApproval::Never,
            sandbox_policy: SandboxPolicy::DangerFullAccess,
            file_system_sandbox_policy: unrestricted_file_system_sandbox_policy(),
            sandbox_permissions: SandboxPermissions::UseDefault,
            prefix_rule: None,
        },
        ExecApprovalRequirement::Forbidden {
            reason: PROMPT_CONFLICT_REASON.to_string(),
        },
    )
    .await;
}

#[tokio::test]
async fn evaluates_powershell_inner_commands_against_allow_rules() {
    assert_exec_approval_requirement_for_command(
        ExecApprovalRequirementScenario {
            policy_src: Some(r#"prefix_rule(pattern=["echo"], decision="allow")"#.to_string()),
            command: vec![
                "powershell.exe".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "echo blocked".to_string(),
            ],
            approval_policy: AskForApproval::UnlessTrusted,
            sandbox_policy: SandboxPolicy::new_read_only_policy(),
            file_system_sandbox_policy: read_only_file_system_sandbox_policy(),
            sandbox_permissions: SandboxPermissions::UseDefault,
            prefix_rule: None,
        },
        ExecApprovalRequirement::Skip {
            bypass_sandbox: true,
            proposed_execpolicy_amendment: None,
        },
    )
    .await;
}

#[test]
fn commands_for_exec_policy_parses_powershell_shell_wrapper() {
    let command = vec![
        "powershell.exe".to_string(),
        "-NoProfile".to_string(),
        "-Command".to_string(),
        "echo blocked".to_string(),
    ];

    assert_eq!(
        commands_for_exec_policy(&command),
        ExecPolicyCommands {
            commands: vec![vec!["echo".to_string(), "blocked".to_string()]],
            used_complex_parsing: false,
            command_origin: ExecPolicyCommandOrigin::PowerShell,
        }
    );
}

#[test]
fn unmatched_safe_powershell_words_are_allowed() {
    let command = vec!["Get-Content".to_string(), "Cargo.toml".to_string()];

    assert_eq!(
        Decision::Allow,
        render_decision_for_unmatched_command(
            &command,
            UnmatchedCommandContext {
                approval_policy: AskForApproval::UnlessTrusted,
                permission_profile: &permission_profile_from_sandbox_policy(
                    &SandboxPolicy::new_read_only_policy(),
                ),
                file_system_sandbox_policy: &read_only_file_system_sandbox_policy(),
                sandbox_cwd: Path::new("/tmp"),
                sandbox_permissions: SandboxPermissions::UseDefault,
                windows_sandbox_level: WindowsSandboxLevel::RestrictedToken,
                used_complex_parsing: false,
                command_origin: ExecPolicyCommandOrigin::PowerShell,
            },
        )
    );
}

#[tokio::test]
async fn unmatched_powershell_delete_requires_approval_when_windows_sandbox_disabled() {
    let command = vec![
        "powershell.exe".to_string(),
        "-NoProfile".to_string(),
        "-Command".to_string(),
        r"Remove-Item C:\Users\root123\Desktop\unsafe.txt".to_string(),
    ];
    let file_system_sandbox_policy = FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd(
        &SandboxPolicy::new_workspace_write_policy(),
        Path::new(r"C:\Users\root123\zspark"),
    );
    let manager = ExecPolicyManager::default();

    let requirement = manager
        .create_exec_approval_requirement_for_command(ExecApprovalRequest {
            command: &command,
            approval_policy: AskForApproval::OnRequest,
            permission_profile: permission_profile_from_sandbox_policy(
                &SandboxPolicy::new_workspace_write_policy(),
            ),
            file_system_sandbox_policy: &file_system_sandbox_policy,
            sandbox_cwd: Path::new(r"C:\Users\root123\zspark"),
            sandbox_permissions: SandboxPermissions::UseDefault,
            windows_sandbox_level: WindowsSandboxLevel::Disabled,
            prefix_rule: None,
        })
        .await;

    assert_eq!(
        requirement,
        ExecApprovalRequirement::NeedsApproval {
            reason: None,
            proposed_execpolicy_amendment: Some(ExecPolicyAmendment::new(vec![
                "Remove-Item".to_string(),
                r"C:\Users\root123\Desktop\unsafe.txt".to_string(),
            ])),
        }
    );
}

#[tokio::test]
async fn unmatched_dangerous_powershell_inner_commands_require_approval() {
    let inner_command = vec![
        "Remove-Item".to_string(),
        "test".to_string(),
        "-Force".to_string(),
    ];

    assert_exec_approval_requirement_for_command(
        ExecApprovalRequirementScenario {
            policy_src: None,
            command: vec![
                "powershell.exe".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "Remove-Item test -Force".to_string(),
            ],
            approval_policy: AskForApproval::OnRequest,
            sandbox_policy: SandboxPolicy::DangerFullAccess,
            file_system_sandbox_policy: unrestricted_file_system_sandbox_policy(),
            sandbox_permissions: SandboxPermissions::UseDefault,
            prefix_rule: None,
        },
        ExecApprovalRequirement::NeedsApproval {
            reason: None,
            proposed_execpolicy_amendment: Some(ExecPolicyAmendment::new(inner_command)),
        },
    )
    .await;
}
