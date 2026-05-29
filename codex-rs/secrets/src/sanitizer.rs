use regex::Regex;
use std::sync::LazyLock;

// OpenAI API keys (sk-...)
static OPENAI_KEY_REGEX: LazyLock<Regex> = LazyLock::new(|| compile_regex(r"sk-[A-Za-z0-9]{20,}"));

// AWS Access Key IDs (AKIA...)
static AWS_ACCESS_KEY_ID_REGEX: LazyLock<Regex> =
    LazyLock::new(|| compile_regex(r"\bAKIA[0-9A-Z]{16}\b"));

// AWS Session Tokens (longer base64-like strings)
static AWS_SESSION_TOKEN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| compile_regex(r"\bFwoGZXIvYXdzE[A-Za-z0-9+/=]{100,}\b"));

// GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
static GITHUB_TOKEN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| compile_regex(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"));

// GitLab tokens (glpat-)
static GITLAB_TOKEN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| compile_regex(r"\bglpat-[A-Za-z0-9\-_]{20,}\b"));

// Slack tokens (xox[baprs]-)
static SLACK_TOKEN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| compile_regex(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}\b"));

// Azure/Entra tokens (eyJ... JWT format)
static JWT_TOKEN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| compile_regex(r"\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b"));

// Bearer tokens in headers
static BEARER_TOKEN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| compile_regex(r"(?i)\bBearer\s+[A-Za-z0-9._\-]{16,}\b"));

// Generic secret assignments (api_key=, token=, secret=, password=)
static SECRET_ASSIGNMENT_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    compile_regex(r#"(?i)\b(api[_-]?key|token|secret|password|credential|auth[_-]?token|access[_-]?token|refresh[_-]?token)\b(\s*[:=]\s*)(["']?)[^\s"']{8,}"#)
});

// URL with credentials (user:pass@host)
static URL_CREDENTIALS_REGEX: LazyLock<Regex> =
    LazyLock::new(|| compile_regex(r"://[^:@/\s]+:[^@/\s]+@"));

/// Remove secrets and keys from a String. This is done on best effort basis following some
/// well-known REGEX patterns for various cloud providers and services.
pub fn redact_secrets(input: String) -> String {
    let redacted = OPENAI_KEY_REGEX.replace_all(&input, "[REDACTED_SECRET]");
    let redacted = AWS_ACCESS_KEY_ID_REGEX.replace_all(&redacted, "[REDACTED_SECRET]");
    let redacted = AWS_SESSION_TOKEN_REGEX.replace_all(&redacted, "[REDACTED_SECRET]");
    let redacted = GITHUB_TOKEN_REGEX.replace_all(&redacted, "[REDACTED_SECRET]");
    let redacted = GITLAB_TOKEN_REGEX.replace_all(&redacted, "[REDACTED_SECRET]");
    let redacted = SLACK_TOKEN_REGEX.replace_all(&redacted, "[REDACTED_SECRET]");
    let redacted = JWT_TOKEN_REGEX.replace_all(&redacted, "[REDACTED_SECRET]");
    let redacted = BEARER_TOKEN_REGEX.replace_all(&redacted, "Bearer [REDACTED_SECRET]");
    let redacted = SECRET_ASSIGNMENT_REGEX.replace_all(&redacted, "\$1\$2\$3[REDACTED_SECRET]");
    let redacted = URL_CREDENTIALS_REGEX.replace_all(&redacted, "://[REDACTED]@");

    redacted.to_string()
}

fn compile_regex(pattern: &str) -> Regex {
    match Regex::new(pattern) {
        Ok(regex) => regex,
        // Panic is ok thanks to load_regex test.
        Err(err) => panic!("invalid regex pattern: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_regex() {
        // The goal of this test is just to compile all the regex to prevent the panic
        let _ = redact_secrets("secret".to_string());
    }

    #[test]
    fn redacts_openai_key() {
        let input = "key: sk-abcdefghijklmnopqrstuvwxyz123456".to_string();
        let result = redact_secrets(input);
        assert!(result.contains("[REDACTED_SECRET]"));
        assert!(!result.contains("sk-abcdefghijklmnopqrstuvwxyz123456"));
    }

    #[test]
    fn redacts_github_token() {
        let input = "token: ghp_1234567890abcdefghijklmnop".to_string();
        let result = redact_secrets(input);
        assert!(result.contains("[REDACTED_SECRET]"));
        assert!(!result.contains("ghp_"));
    }

    #[test]
    fn redacts_url_credentials() {
        let input = "postgres://user:secretpassword@localhost:5432/db".to_string();
        let result = redact_secrets(input);
        assert!(result.contains("[REDACTED]@"));
        assert!(!result.contains("secretpassword"));
    }

    #[test]
    fn redacts_bearer_token() {
        let input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9".to_string();
        let result = redact_secrets(input);
        assert!(result.contains("Bearer [REDACTED_SECRET]"));
    }
}
