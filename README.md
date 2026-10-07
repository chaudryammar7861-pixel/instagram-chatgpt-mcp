# Instagram → ChatGPT MCP Server

Open-source MCP server for connecting an Instagram **Professional (Business or Creator)** account to an MCP client such as ChatGPT, using Meta's official Instagram Platform API and OAuth. It does not ask for or store your Instagram password.

## What it supports

- Read profile information
- Read posts/reels
- Publish image posts
- Publish reels
- Read account/media insights
- Read comments
- Reply to comments
- Hide/unhide comments
- Delete comments
- Delete media where Meta permits the operation

## Important platform limits

Meta's Instagram Platform API is for Professional accounts (Business/Creator). Personal accounts need to be converted first. API permissions and available metrics can change; use the current Meta App Dashboard and documentation when configuring the app.

Publishing requires the media to be reachable by Meta at a public HTTPS URL. A local `file://` or localhost URL will not work.

## Architecture

ChatGPT/MCP client → HTTPS `/mcp` + Bearer token → this server → official `graph.instagram.com` API.

OAuth endpoints:
- `/oauth/start`
- `/oauth/callback`

The MCP endpoint requires `Authorization: Bearer $MCP_AUTH_TOKEN`. Keep this separate from the Meta access token.

Tokens are stored in a local SQLite database. The Instagram password is never handled by this server.

## Local setup

1. Install Node.js 22+.
2. Create a Meta developer app and add Instagram API with Instagram Login.
3. Configure OAuth redirect URI as `https://YOUR-DOMAIN/oauth/callback` (or your local tunnel URL).
4. Request these scopes:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `instagram_business_manage_comments`
   - `instagram_business_manage_insights`
5. Copy `.env.example` to `.env` and fill in App ID, App Secret, redirect URI, public URL and a strong session secret.
6. Run:

```bash
npm install
npm run build
npm start
```

7. Open `https://YOUR-DOMAIN/oauth/start` in a browser and approve Instagram access.
8. Configure your MCP client to use `https://YOUR-DOMAIN/mcp` with Streamable HTTP.

## Docker

```bash
docker build -t instagram-chatgpt-mcp .
docker run --rm -p 3000:3000 --env-file .env -v "$PWD/data:/app/data" instagram-chatgpt-mcp
```

## Production notes

- Put the server behind HTTPS.
- Keep `META_APP_SECRET`, `MCP_AUTH_TOKEN`, and the SQLite database private.
- Back up the SQLite database securely; it contains access tokens.
- Do not commit `.env` or the SQLite database.
- Add rate limiting, structured audit logs, CSRF protections around OAuth, and persistent/session-aware MCP handling before exposing this to multiple users.
- For a personal/single-account deployment, the included SQLite token store is intentionally simple.

## ChatGPT connection

ChatGPT needs a publicly reachable HTTPS MCP endpoint. The source package cannot itself create that public endpoint. Deploy this server first, then add its MCP URL in the ChatGPT connector/plugin flow available to your account.

## Meta references

Use Meta's current Instagram Platform documentation and App Dashboard for the exact current scopes, review requirements, API version and redirect URI settings.
