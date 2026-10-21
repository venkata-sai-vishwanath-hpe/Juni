# Setup Guide — Juni

*Your network, one text away.*

Chat with your Juniper Junos routers from WhatsApp in plain English. This guide
takes you from a fresh clone to sending `@juni what routers are available?` and
getting a real answer back.

The system has **two parts** that run together:

| Part | Folder | What it does |
| --- | --- | --- |
| **Junos MCP server** | `junos-mcp-server/` ([Juniper/junos-mcp-server](https://github.com/Juniper/junos-mcp-server)) | Talks to your routers over SSH and exposes them as tools over HTTP. |
| **Juni (WhatsApp bridge)** | `Juni/` (this repo) | A VS Code extension that links WhatsApp, asks an AI model your question, runs the MCP tools, and replies. |

```
WhatsApp phone ──► Bridge (VS Code extension) ──► AI model (Copilot)
                            │
                            └──► Junos MCP server ──SSH──► your routers
```

---

## 1. Prerequisites

| Requirement | Check with | If missing |
| --- | --- | --- |
| **macOS / Linux** | — | — |
| **Python 3.10+** | `python3 --version` | Install from <https://python.org> |
| **Node.js 18+** | `node -v` | Install from <https://nodejs.org> |
| **VS Code** | `code --version` | <https://code.visualstudio.com> |
| **GitHub Copilot Chat** (signed in) | Copilot icon in the VS Code status bar | Install "GitHub Copilot Chat" from the Extensions view and sign in |
| **Network access to your routers** on SSH port 22 | `nc -z <router-ip> 22` | Fix VPN / routing first |

> Clone both repos **next to each other** so the setup script can find the server:
>
> ```bash
> git clone https://github.com/venkata-sai-vishwanath-hpe/Juni.git
> git clone https://github.com/Juniper/junos-mcp-server.git
> ```

---

## 2. Set up the Junos MCP server

### 2.1 Create the Python environment

```bash
cd junos-mcp-server
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
./.venv/bin/pip install "mcp[cli]>=1.12.2,<2.0"
```

> **Important:** the server targets the **`mcp` 1.x API**. Keep `mcp` below 2.0,
> or startup fails with `ImportError: cannot import name 'ServerSessionT'`.

Verify the install:

```bash
./.venv/bin/python -c "import jnpr.junos, mcp, uvicorn, starlette; print('deps ok')"
```

### 2.2 Configure your routers

Edit `junos-mcp-server/devices.json`. Each entry maps a short name (used in
WhatsApp, e.g. `r1`) to a router:

```jsonc
{
    "r1": {
        "ip": "192.0.2.10",
        "port": 22,
        "username": "admin",
        "auth": { "type": "password", "password": "yourpassword" }
    },
    "r2": {
        "ip": "192.0.2.11",
        "port": 22,
        "username": "admin",
        "auth": { "type": "password", "password": "yourpassword" }
    }
}
```

SSH-key auth is also supported — see `devices-template.json` for examples
(`"type": "ssh_key"`, `private_key_path`, optional `ssh_config`).

**Quick sanity check** that a router is reachable and the credentials work:

```bash
./.venv/bin/python -c "
from jnpr.junos import Device
d = Device(host='192.0.2.10', user='admin', password='yourpassword')
d.open(); print('CONNECTED:', d.facts.get('hostname'), d.facts.get('model')); d.close()
"
```

### 2.3 Start the server

The bridge talks to the server over HTTP on port **30030**. Start it and
**leave this terminal open**:

```bash
cd junos-mcp-server
./.venv/bin/python jmcp.py -t streamable-http -H 127.0.0.1 -p 30030 \
  -f devices.json --allow-unauthenticated-http
```

You should see `All N device(s) validated successfully` and
`Uvicorn running on http://127.0.0.1:30030`.

> `--allow-unauthenticated-http` is for **local development only** — it skips
> token auth and only binds to loopback (`127.0.0.1`). For anything beyond your
> own machine, set up a token (see `junos-mcp-server/README.md`) and put it in
> the bridge config `headers`.

Confirm it's listening (in another terminal):

```bash
lsof -nP -iTCP:30030 -sTCP:LISTEN
```

---

## 3. Set up the WhatsApp bridge

Choose **one** of the two methods below. **Method A (install the packaged
extension) is recommended** — it runs in your normal VS Code and avoids the
Extension Development Host entirely.

### Method A — Install as a packaged extension (recommended)

```bash
cd Juni
npm install
npm run build
npx --yes @vscode/vsce package --allow-missing-repository --skip-license \
  -o junos-whatsapp-bridge.vsix
code --install-extension junos-whatsapp-bridge.vsix --force
```

Then reload VS Code: `Cmd+Shift+P` → **Developer: Reload Window**.

The command **Junos WhatsApp: Start Bridge** is now available in any VS Code
window — no F5, no second window.

### Method B — Run from source (for development)

```bash
cd Juni
npm install
npm run build
```

Then either:

- **Open the folder and press F5:** `code Juni`, select
  **Run Junos WhatsApp Bridge** in the Run and Debug panel, press F5. A second
  **[Extension Development Host]** window opens. *(If F5 does nothing, make sure
  the workspace is trusted and the folder is opened as the workspace root.)*
- **Or launch the dev host from the CLI:**

  ```bash
  code -n "Juni" \
    --extensionDevelopmentPath="$(pwd)/Juni"
  ```

---

## 4. Configure the AI and tools (optional)

Everything lives in `Juni/bridge.config.json`. Open it with
`Cmd+Shift+P` → **Junos WhatsApp: Open Config File**. Defaults work out of the
box with Copilot.

```jsonc
{
  "ai": {
    "provider": "copilot",          // copilot (no key) | openai | anthropic | gemini
    "model": "claude-sonnet-4.5",   // a Copilot model family, or the provider's model id
    "apiKeys": { "openai": "", "anthropic": "", "gemini": "" }
  },
  "mcp": {
    "enabledTools": "readonly",     // "readonly" = safe tools only | "all" = everything
    "servers": [
      { "name": "junos", "url": "http://localhost:30030/mcp", "headers": {} }
    ]
  },
  "whatsapp": {
    "triggerPrefix": "@juni",
    "allowedNumbers": []            // digits + country code, no '+'
  }
}
```

- **Pick a Copilot model** interactively: `Cmd+Shift+P` →
  **Junos WhatsApp: Select Copilot Model**.
- **`enabledTools`**: keep `"readonly"` to prevent config changes; use `"all"`
  only when you want the bot to be able to commit configuration.
- Restart the bridge after editing (**Stop Bridge**, then **Start Bridge**).

---

## 5. Link WhatsApp and test

1. Make sure the **MCP server is running** (Part 2.3).
2. `Cmd+Shift+P` → **Junos WhatsApp: Start Bridge**.
3. A **QR code** panel appears.
4. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device** →
   scan the QR.
5. Wait for **"WhatsApp is linked and ready."**
6. Open your own **"Message yourself"** chat and send:

   ```
   @juni what routers are available?
   ```

You should get a reply listing your routers. 🎉

### Talking to the bot

- **From your own number:** start the message with the trigger **`@juni`**.
- **Let a colleague use it:** add their number (country code + digits, no `+`)
  to `whatsapp.allowedNumbers` — they message your linked account directly, no
  prefix needed.

Things to try:

```
@juni what routers do I have?
@juni gather facts for r1
@juni show me the current config on r1
@juni show me the config diff on r1
```

---

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ImportError: cannot import name 'ServerSessionT'` | `mcp` 2.x got installed. Reinstall 1.x: `./.venv/bin/pip install "mcp[cli]>=1.12.2,<2.0"`. |
| `address already in use` on port 30030 | The server is **already running** — that's fine. To restart it, find it with `lsof -nP -iTCP:30030 -sTCP:LISTEN` and `kill <PID>`. |
| Bridge says it can't reach the MCP server | Make sure Part 2.3 is running and `bridge.config.json` `url` is `http://localhost:30030/mcp`. |
| **F5 does nothing** | Use **Method A** (install the VSIX). Otherwise: trust the workspace (`Workspaces: Manage Workspace Trust`) and confirm the Run config **Run Junos WhatsApp Bridge** is selected. |
| Extension Development Host **opens then closes** | Use **Method A** — the packaged extension runs in your normal window and doesn't have this problem. |
| "No Copilot chat models are available" | Install **GitHub Copilot Chat** and sign in; then run **Junos WhatsApp: Select Copilot Model**. |
| Want a **fresh QR / new WhatsApp account** | Each **Start Bridge** resets the login by default (`junosWhatsapp.resetAuthOnStart = true`), so just start the bridge again. |
| Router not reachable | `nc -z <router-ip> 22` — fix VPN/routing/credentials before retrying. |

---

## Security notes

- `--allow-unauthenticated-http` is **local-only**. Never expose port 30030 off
  your machine without token auth.
- `devices.json` and `bridge.config.json` can contain **router passwords and API
  keys** — keep them out of version control.
- Keep `enabledTools` on `"readonly"` unless you explicitly want the bot to
  change router configuration.
