# zspark server

Self-hosted collaboration hub.

- Fastify + WebSocket
- Yjs (y-websocket) for shared chat / docs CRDT
- Postgres for persistence
- Redis for presence
- Kerberos SPNEGO middleware for Windows Domain SSO
- Microsoft Teams bot adapter

Deploy via `docker compose up -d`. User will provide a Linux host when this track is ready.
