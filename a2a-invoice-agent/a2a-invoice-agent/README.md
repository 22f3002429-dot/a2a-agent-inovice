# A2A Invoice Action Agent

Zero-dependency Node.js (>=18) A2A 1.0 HTTP+JSON agent. AI decisions via OpenRouter.

## Env vars
| Name | Meaning |
|---|---|
| OPENROUTER_API_KEY | your OpenRouter key (set on the host, never commit) |
| OPENROUTER_MODEL | default `openai/gpt-4o-mini` (a `:free` model also works) |
| PUBLIC_BASE_URL | exact base URL you submit, e.g. `https://my-app.onrender.com/a2a` |
| AGENT_TOKENS | optional comma list of allowed tokens (blank = any Bearer token, each isolated) |
| DATA_DIR | state dir (use a persistent disk if the host has one) |

## Run locally
    OPENROUTER_API_KEY=... PUBLIC_BASE_URL=http://localhost:8080 node server.js
    MOCK_AI=1 node server.js & node test/smoke.js   # protocol test, no AI

Routes: `/.well-known/agent-card.json` (origin level) and `{base}/message:send`, `{base}/tasks`, `{base}/tasks/{id}`, `{base}/tasks/{id}:cancel`. Routes also work at the root, so base can be `https://host` or `https://host/a2a`.
