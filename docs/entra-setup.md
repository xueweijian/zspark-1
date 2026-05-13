# Entra ID (Azure China) Setup for zspark

zspark 用 Microsoft Entra ID（Azure China 版）做用户身份。Desktop 端走 MSAL
public client flow（loopback redirect），server 端校验 JWT 签名（JWKS from
`https://login.partner.microsoftonline.cn`）。

这里的 Entra ID 只负责判断“谁能访问共享 workspace”。模型 API key 仍然走
desktop 本地 provider 设置，不由 Entra ID 分发。

## 你需要在 Azure China Portal 做的事

> Portal 入口：<https://portal.azure.cn>

### 1. 创建 App Registration

1. **Microsoft Entra ID → App registrations → New registration**
2. Name: `zspark-desktop`
3. Supported account types: **Accounts in this organizational directory only**
4. Redirect URI: 选 **Public client/native (mobile & desktop)**，填
   `http://localhost`
5. 注册后记下:
   - `Application (client) ID` → 给 desktop 当 `ZSPARK_CLIENT_ID`
   - `Directory (tenant) ID` → 给 desktop + server 当 `ZSPARK_TENANT_ID`
6. 进入 **Authentication → Advanced settings**，把
   **Allow public client flows** 设为 **Yes**。
   如果没开，设备码页面会显示登录成功，但 desktop 换 token 时会返回
   `invalid_client` / `AADSTS7000218`。

### 2. 暴露一个 API（给 server 当 audience）

1. 进入刚建的 app → **Expose an API**
2. **Set** Application ID URI（默认 `api://<client-id>` 即可，按 Save）
3. **Add a scope**:
   - Scope name: `access_as_user`
   - Who can consent: Admins and users
   - Admin consent display name: `Access zspark on your behalf`
   - State: Enabled
4. 完整 scope 字符串会是 `api://<client-id>/access_as_user`，记下来给 desktop

### 3. API permissions（让 desktop 能调自己暴露的 API）

1. **API permissions → Add a permission → My APIs → 选刚建的 zspark-desktop →
   Delegated → access_as_user → Add**
2. 点 **Grant admin consent for <你的租户>**（需要 Global Admin 或 Cloud
   Application Admin）

### 4. （可选）Microsoft Teams 应用

要把 zspark 装进 Teams 当 bot/tab，需要单独走 **Bot Channels Registration**
和上传 manifest，本文档暂不展开。

## Desktop 端环境变量

打包 installer 时通过 electron-builder 的 `extraMetadata` 注入：

```
ZSPARK_TENANT_ID=<step1.directory id>
ZSPARK_CLIENT_ID=<step1.application id>
ZSPARK_API_SCOPE=api://<client-id>/access_as_user
ZSPARK_AUTHORITY=https://login.partner.microsoftonline.cn/<tenant-id>
ZSPARK_SERVER_URL=http://143.64.174.225:8787
```

## Server 端环境变量

```
NODE_ENV=production
ZSPARK_TENANT_ID=<...>
ZSPARK_CLIENT_ID=<...>            # 用于 aud 校验
ZSPARK_AUTHORITY=https://login.partner.microsoftonline.cn/<tenant-id>/v2.0
ZSPARK_CORS_ORIGINS=https://your-desktop-shell-origin.example
ZSPARK_ARTIFACT_STORAGE_DIR=/data/artifacts
```

服务器启动时会通过 `<authority>/discovery/v2.0/keys` 校验 JWKS，并固定只接受
`RS256` token。`X-Domain-User` 只在 `NODE_ENV=development` 且未配置 Entra 时可用，
生产环境不要打开这个 dev shim。

## Shared workspace 行为

- 本地普通 workspace 和 Recent chats 保持本机私有。
- 共享 workspace 会出现在 desktop 左侧独立的 **Shared workspaces** 区域。
- desktop 登录 Entra ID 后，带 `Authorization: Bearer <token>` 调用 server。
- server 根据 JWT 中的 `oid`、`preferred_username/upn`、`groups` 生成 ACL key，
  只返回当前用户有权限访问的 workspace。
