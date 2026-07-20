---
name: cortex-setup
description: Initialize Cortex for first-time use
allowed-tools: Bash, Write, Read, AskUserQuestion
user-invocable: true
---

# Cortex Setup Wizard

Initialize Cortex for first-time use.

## Setup Steps

### 1. Initialize System

Run the internal setup command to create directories and database:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/index.js setup
```

### 2. Configure Preferences

Ask the user to choose a configuration preset:

**Question:** How would you like Cortex to behave?

1. **Full Automation (Recommended)**
   - **Protection**: Saves seamlessly while you work (every 5% context).
   - **Clear Safety**: Automatically saves backup before you clear context.
   - **Visuals**: Shows "Saved" notifications.

2. **Balanced**
   - **Protection**: Saves less frequently (every 10%).
   - **Clear Safety**: Automatically saves backup before clear.
   - **Visuals**: Standard status bar.

3. **Silent Mode**
   - **Protection**: **Manual saving only**.
   - **Clear Safety**: Automatically saves backup before clear.
   - **Visuals**: Hidden status bar.

### 3. Apply Preset

Based on the user's choice (1, 2, or 3), apply the corresponding preset:

**If "1" or "Full":**
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/index.js configure full
```

**If "2" or "Balanced":**
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/index.js configure essential
```

**If "3" or "Silent":**
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/index.js configure minimal
```

### 4. Choose Server Mode

Ask the user how Cortex should run:

**Question:** Do you often run several Claude Code sessions at the same time?

1. **Shared daemon (recommended for multiple sessions)**
   - ONE background server holds the database + embedding model for ALL sessions.
   - Large RAM savings (each session uses a thin ~50MB proxy instead of loading everything).
   - The daemon starts automatically and auto-updates when the plugin updates.

2. **Classic per-session (default)**
   - Each Claude Code session loads its own copy of the database and model.
   - Simplest option for a single session at a time.

**If "1" or "Shared daemon":**
```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/index.js configure daemon on
```

**If "2" or "Classic":** do nothing (this is the default).

### 5. Finish

Print the success message:
"✅ Cortex is ready! Now restart Claude Code to enable memory tools."
