# zspark

zspark is an open-source desktop and collaboration shell built on top of the open-source [Codex](https://github.com/openai/codex) runtime.

It aims to bring the product shape of Claude Code, Claude cowork, and Codex App into a self-hostable project: a local agent desktop, native Codex sessions, skills and plugins, file artifacts, enterprise identity, and shared workspaces that teams can run on their own infrastructure.

> zspark is not affiliated with OpenAI. It uses a forked/open-source Codex runtime as the agent engine.

## Why zspark exists

Codex is a strong local agent runtime, but many useful product capabilities live in closed products: desktop UX, shared cowork sessions, enterprise authentication, office-oriented skills, plugin discovery, downloadable artifacts, and collaboration around a shared workspace.

zspark makes those layers hackable:

- Build new features without waiting for a closed desktop app to expose them.
- Run the collaboration server yourself.
- Connect enterprise authentication and authorization to shared workspaces.
- Use Codex-native sessions, memory, tools, spawn behavior, skills, and plugins from an open shell.
- Connect both Responses API providers and Chat Completions-only providers through the same desktop.

## What it does

- **Codex-powered desktop agent**: Electron shell around the Codex app-server runtime, without requiring Codex App.
- **Native Codex runtime behavior**: sessions, memory, tool calls, permissions, sandbox policy, and spawn/sub-agent behavior come from Codex instead of being reimplemented in JavaScript.
- **Skills and plugins**: discovers locally installed Codex skills/plugins and exposes them in the zspark UI, including productivity workflows such as presentations, documents, and spreadsheets when the corresponding runtime is available.
- **File input and artifacts**: attach local files to a conversation and surface generated files back in the chat as downloadable artifacts.
- **OpenAI Responses API support**: talks directly to providers that implement the Responses API.
- **Chat Completions bridge**: lets Codex drive providers that only expose `/v1/chat/completions`, including many OpenAI-compatible model gateways and self-hosted stacks.
- **Shared workspaces**: a self-hosted server stores shared workspaces, sessions, activity, and artifacts so multiple users can continue each other's work.
- **Enterprise identity**: Microsoft Entra ID support is built in for controlling who can access shared workspaces. The current setup targets Azure China as well as standard Entra-shaped JWT validation.
- **Cross-platform desktop**: macOS and Windows desktop builds are supported. The shared server is designed to run on Linux.

## Repository layout

```text
zspark/
  codex-rs/   Forked Codex runtime and app-server engine
  desktop/    Electron desktop shell for macOS and Windows
  server/     Self-hosted shared workspace server
  docs/       Setup notes for enterprise auth and contributors
```

## Architecture

```text
Desktop app
  -> bundled codex binary
  -> codex app-server
  -> local workspace, local Codex config, skills, plugins, tools
  -> model provider through Responses API or zspark's Chat Completions bridge

Shared workspace mode
  -> zspark server
  -> Entra ID / dev identity
  -> Postgres for workspaces, sessions, messages, artifacts
  -> Redis + Yjs/WebSocket for collaboration state
```

Local workspaces stay private on the machine. Shared workspaces are explicitly created through the server and are visible only to principals authorized for that workspace.

## Status

This is an early open-source release. The core desktop loop, provider configuration, Chat API bridge, shared workspace server, artifact upload/download, and Entra-based authentication path are present, but expect rough edges while the project is moving quickly.

The project is useful for builders who want a hackable Codex-based desktop today, and for teams that want to experiment with a self-hosted coworking agent surface.

## Prerequisites

- Git
- Node.js 22+
- npm 10+ or npm 11+
- Rust stable toolchain
- Docker and Docker Compose, only needed for the shared workspace server

On Windows, install Git for Windows, Node.js, Rust, and Docker Desktop if you plan to run the server locally. The desktop build expects the Codex binary to be built before packaging.

## Quick start: desktop development

Clone the repository:

```bash
git clone https://github.com/hellangleZ/zspark.git
cd zspark
```

Build the Codex runtime:

```bash
cd codex-rs
cargo build --release -p codex-cli --bin codex
cd ..
```

Install and run the desktop app:

```bash
cd desktop
npm install
npm run dev
```

The desktop app starts the local `codex app-server` process and connects the UI to it.

## Configure a model provider

Open the desktop settings and configure:

- Base URL
- API key
- Model name
- Wire API: `responses` or `chat`

Use `responses` for providers that support OpenAI's Responses API.

Use `chat` for providers that expose Chat Completions only. zspark starts a local bridge that translates the subset Codex needs between Responses-style requests and `/v1/chat/completions`, including tool calls.

Examples of provider families people commonly try through the chat bridge include DeepSeek-compatible gateways, Kimi-compatible gateways, vLLM, SGLang, Ollama, and other OpenAI-compatible servers. Exact model behavior still depends on the provider's tool-call and streaming support.

## Build installers

Build the Codex binary first:

```bash
cd codex-rs
cargo build --release -p codex-cli --bin codex
cd ..
```

Build macOS:

```bash
cd desktop
npm install
npm run build:mac
```

Build Windows:

```powershell
cd desktop
npm install
npm run build:win
```

Windows output is written under `desktop/dist/`. If Electron Builder fails while extracting signing helpers because symlink privileges are unavailable, enable Developer Mode or run the shell as Administrator.

## Shared workspace server

The shared server is optional. You only need it if you want multiple users or multiple machines to collaborate in the same workspace.

Start it locally:

```bash
cd server
docker compose up -d --build
curl http://127.0.0.1:8787/healthz
```

The server starts:

- Fastify API on port `8787`
- Postgres for workspace/session/artifact persistence
- Redis for collaboration support

Desktop clients should point their enterprise/shared workspace settings at the server URL, for example:

```text
http://YOUR_SERVER_IP:8787
```

## Entra ID setup

zspark can use Microsoft Entra ID to decide who can access shared workspaces. The server validates bearer tokens, derives principal keys from the token, and checks workspace ownership or membership.

Important environment variables:

```bash
ZSPARK_TENANT_ID=...
ZSPARK_CLIENT_ID=...
ZSPARK_API_SCOPE=api://<client-id>/access_as_user
ZSPARK_AUTHORITY=https://login.partner.microsoftonline.cn/<tenant-id>
ZSPARK_SERVER_URL=http://YOUR_SERVER_IP:8787
```

For Azure China setup details, see [docs/entra-setup.md](docs/entra-setup.md).

For local development without Entra ID, the server supports an `X-Domain-User` dev identity shim when Entra variables are not configured.

## Shared workspace behavior

In shared mode:

- Users sign in and receive access only to workspaces they own or belong to.
- Sessions created inside a shared workspace are listed for other authorized users.
- Generated artifacts can be uploaded to the shared server and downloaded from the conversation.
- A teammate can continue from a shared session, create new outputs, and make those outputs visible to the workspace.

Local recent chats remain local. Shared workspaces are intentionally shown separately in the desktop UI.

## Skills, plugins, and office workflows

zspark does not try to re-create every skill in the desktop layer. The goal is to let Codex use the skills/plugins it already knows how to use, while the desktop makes them visible and gives the user a better surface for files, activity, and artifacts.

When the local Codex runtime has productivity skills available, zspark can surface workflows such as:

- presentations and `.pptx` generation
- documents and `.docx` work
- spreadsheets and `.xlsx` work
- browser/computer-use style workflows when the corresponding tools are installed

Generated files should appear as conversation artifacts where possible, including in shared workspaces.

## Development commands

Desktop:

```bash
cd desktop
npm run typecheck
npm test
npm run build
```

Server:

```bash
cd server
npm run typecheck
npm run build
```

Codex runtime:

```bash
cd codex-rs
cargo build --release -p codex-cli --bin codex
```

## Security notes

- Do not commit API keys, Entra secrets, generated user data, or local artifacts.
- The desktop stores provider credentials locally and passes model keys to Codex through environment variables.
- Shared workspace access depends on the server's identity configuration and workspace ACL checks.
- Run the shared server behind your own network boundary or reverse proxy before using it with a real team.

## Contributing

Issues and pull requests are welcome. The most useful contributions right now are:

- provider compatibility fixes for Chat Completions and Responses APIs
- better desktop UX around files, activity, approvals, and artifacts
- shared workspace collaboration improvements
- enterprise auth and deployment hardening
- skill/plugin discovery and runtime integration improvements

## License

See the repository license before using zspark in production.
