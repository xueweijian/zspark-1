# Entra ID (Azure China) Setup for zspark

zspark 用 Microsoft Entra ID（Azure China 版）做用户身份。Desktop 端走 MSAL
public client flow（loopback redirect），server 端校验 JWT 签名（JWKS from
`https://login.partner.microsoftonline.cn`）。

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
ZSPARK_SERVER_URL=https://zspark.your-corp.cn
```

## Server 端环境变量

```
ZSPARK_TENANT_ID=<...>
ZSPARK_CLIENT_ID=<...>            # 用于 aud 校验
ZSPARK_AUTHORITY=https://login.partner.microsoftonline.cn/<tenant-id>/v2.0
```

服务器启动时会自动拉 `<authority>/discovery/v2.0/keys` 拿 JWKS，缓存 12h。
