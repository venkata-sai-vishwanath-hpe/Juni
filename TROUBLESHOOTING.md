# WhatsApp Bridge Troubleshooting

## MessageCounterError: "Key used already or never filled"

This error occurs when the Signal Protocol session cipher fails due to message counter desynchronization.

### Causes
- **Stale auth state**: Stored credentials/sessions are out of sync with WhatsApp's servers
- **Multiple instances**: Running bridge and another WhatsApp Web client simultaneously  
- **Session reset**: WhatsApp Web was force-logged on phone or computer
- **Network interruption**: Losing connection mid-sync

### Solutions

#### Quick Fix (Easiest)
1. **Clear authentication state:**
   ```bash
   rm -rf /path/to/WA_AUTH_DIR/*
   ```
   Replace `/path/to/WA_AUTH_DIR` with your actual auth directory path

2. **Restart the bridge** and re-scan the QR code

#### Preventive Measures

1. **Ensure single instance**: Close WhatsApp Web browser tabs before running the bridge
   - Don't run multiple WhatsApp Web sessions (phone + bridge + browser)
   - Only one connection per WhatsApp account at a time

2. **Check auth directory**: 
   ```bash
   ls -la $WA_AUTH_DIR
   ```
   Should show: `creds.json` and `sessions/` folder with session files

3. **Verify environment variable**:
   ```bash
   echo $WA_AUTH_DIR
   ```

#### If Problem Persists

1. **Unlink from phone**: In WhatsApp settings → Linked devices, remove the bridge device
2. **Clear all auth files** and re-authenticate
3. **Check Baileys version**: Latest Baileys versions have better session handling
   ```bash
   npm list @whiskeysockets/baileys
   ```

#### For Development/Testing

If testing locally, use a separate test phone number or WhatsApp Business account to avoid conflicts with your primary WhatsApp connection.

## Bad MAC Error: "Bad MAC" / "Error: Bad MAC"

This is a **Message Authentication Code failure** during Signal Protocol decryption. It's usually harmless.

### When It Happens
- During initial sync after re-linking (syncing cached message history)
- When old messages with mismatched session keys are being processed
- Typically right after `"Saw message"` log lines

### Is It a Problem?
**No, usually.** The bridge catches and skips these messages silently. They're almost always old cached messages or duplicates from sync.

### When It Becomes a Problem
If you see Bad MAC errors mixed with:
- Recent/new messages not being received
- Bridge disconnecting frequently
- `MessageCounterError` or `Failed to decrypt message` errors

Then your session is genuinely out of sync. **Solution:** Clear auth and re-authenticate (see MessageCounterError section above).

### What's Being Logged
```
Skipped message (decryption mismatch, likely old cached message)
```
This is **informational** — the bridge is working correctly by ignoring these.

## Logs to Check

The worker logs go to the extension's output channel "Junos WhatsApp". Check for:
- `Failed to decrypt message` → Session out of sync
- `Connection closed` → Network or auth issue
- `handleIncoming error` → Message processing failure

## Prevention Strategy

- Keep browser tab closed while bridge is running
- Use consistent `WA_AUTH_DIR` path
- Don't switch devices while bridge is active
- Monitor the output channel for connection warnings
