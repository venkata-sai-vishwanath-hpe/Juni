#!/usr/bin/env bash
#
# One-command setup for the Junos WhatsApp Bridge.
# Checks prerequisites, installs dependencies, and builds the extension.
#
# Usage:  ./setup.sh
#
set -euo pipefail

cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

bold "Junos WhatsApp Bridge — setup"
echo

# 1. Node.js
bold "1/4  Checking Node.js"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "Node $(node -v)"
  else
    fail "Node 18+ required (found $(node -v)). Install from https://nodejs.org"
  fi
else
  fail "Node.js not found. Install from https://nodejs.org and re-run."
fi

# 2. Python + Junos MCP server
bold "2/4  Checking Python + Junos MCP server"
PY="${PYTHON:-python3}"
if command -v "$PY" >/dev/null 2>&1; then
  ok "Python $($PY --version 2>&1 | awk '{print $2}') ($PY)"
else
  fail "Python interpreter '$PY' not found. Set PYTHON=/path/to/python and re-run."
fi

SERVER_DIR="$(cd .. && pwd)/junos-mcp-server"
if [ -f "$SERVER_DIR/jmcp.py" ]; then
  ok "Found Junos MCP server at $SERVER_DIR"
else
  warn "junos-mcp-server not found next to this folder."
  warn "You'll need to set 'junosWhatsapp.serverCwd' in VS Code settings later."
fi

if "$PY" -c "import jnpr.junos" >/dev/null 2>&1; then
  ok "Junos PyEZ (jnpr.junos) importable"
else
  warn "Could not import jnpr.junos with '$PY'."
  warn "Install the server deps:  cd $SERVER_DIR && pip install -r requirements.txt"
fi

# 3. Install Node dependencies
bold "3/4  Installing dependencies"
npm install >/dev/null 2>&1 && ok "npm install complete" || fail "npm install failed. Run 'npm install' to see the error."

# 4. Build
bold "4/4  Building the extension"
npm run build >/dev/null 2>&1 && ok "Build complete (out/extension.js)" || fail "Build failed. Run 'npm run build' to see the error."

echo
bold "Setup done! Next steps:"
echo "  1. Open this folder in VS Code:   code ."
echo "  2. Press F5 (launches the bridge in a new window)."
echo "  3. In that window:  Cmd+Shift+P  →  'Junos WhatsApp: Start Bridge'"
echo "  4. Scan the QR with WhatsApp  →  Linked Devices  →  Link a Device."
echo "  5. Message yourself:  @juni what routers are available?"
echo
