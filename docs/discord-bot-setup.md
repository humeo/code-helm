# Discord Bot Setup

This guide covers the minimum Discord setup CodeHelm expects before you run `code-helm onboard`.

## What CodeHelm Needs

CodeHelm currently assumes:

- one Discord application with a bot user
- one target server
- one control channel in that server
- public threads enabled in that control channel
- slash commands installed in that server
- `Message Content Intent` enabled for the bot

You do not need to give the bot `Administrator`.

## Required OAuth2 Scopes

When you generate the invite URL, enable these scopes:

- `bot`
- `applications.commands`

`applications.commands` installs the slash commands. `bot` gives the bot user access to the server.

## Recommended Bot Permissions

These permissions match the current implementation surface:

| Permission | Why CodeHelm needs it |
| --- | --- |
| `View Channels` | Read the control channel and the session threads it manages |
| `Send Messages` | Post control-channel replies and thread starter messages |
| `Create Public Threads` | Create the managed session threads from the control channel |
| `Send Messages in Threads` | Post transcript, status, and approval updates inside session threads |
| `Manage Threads` | Archive and unarchive managed session threads during close, resume, and recovery flows |
| `Read Message History` | Recover status cards and approval messages after restart or reconnect |
| `Use Slash Commands` | Receive `/workdir`, `/session-new`, `/session-resume`, `/session-sync`, and `/session-close` |
| `Embed Links` | Render status, warning, and approval embeds cleanly |

CodeHelm does not currently require webhook management, forum-channel management, or full server-wide administration.

## Choose The Right Control Channel

During onboarding, CodeHelm only accepts:

- text channels
- announcement channels

The control channel must allow public threads, because CodeHelm creates one managed Discord thread per attached session.

If the channel cannot create public threads, session creation and session attachment will fail even if slash commands are installed correctly.

## Setup Steps

### 1. Create the Discord application

Create a new application in the Discord Developer Portal:

<https://discord.com/developers/applications>

### 2. Add a bot user and copy the token

In the application:

1. Open `Bot`
2. Create the bot user if the application does not have one yet
3. Reset or copy the bot token
4. Store it somewhere safe for `code-helm onboard`

### 3. Enable Message Content Intent

In `Bot`, enable `Message Content Intent`.

CodeHelm needs message content so it can read Discord messages in managed session threads and forward user input into Codex.

### 4. Generate the invite URL

In `OAuth2 > URL Generator`:

1. Enable the `bot` scope
2. Enable the `applications.commands` scope
3. Enable the permissions listed above
4. Open the generated URL and install the bot into your target server

### 5. Pick a control channel

Pick one text or announcement channel where:

- the bot can post messages
- the bot can create public threads
- the people using CodeHelm are allowed to run slash commands

CodeHelm binds itself to one configured guild and one configured control channel at a time.

### 6. Run onboarding

Once the bot is in the server, run:

```bash
code-helm onboard
```

The onboarding flow will ask for:

- the bot token
- the target server
- the control channel

## Quick Verification Checklist

Before you start CodeHelm, confirm:

- the bot shows as a member of the target server
- `/session-new` appears in the chosen control channel
- the chosen control channel supports public threads
- `Message Content Intent` is enabled
- the bot can post a normal message in the chosen control channel

## Troubleshooting

### Slash commands do not appear

Check these first:

- the bot was invited with the `applications.commands` scope
- you selected the correct server during invite
- you are running commands in the configured guild, not in DMs

### Session creation fails when opening a thread

This usually means one of these is missing in the control channel:

- `Create Public Threads`
- `Send Messages`
- `View Channels`

### Session thread updates fail after creation

Check:

- `Send Messages in Threads`
- `Manage Threads`
- `Read Message History`
- `Embed Links`

### CodeHelm does not react to Discord messages

Check:

- `Message Content Intent` is enabled in the Developer Portal
- the bot was restarted after changing the intent setting
- the message was sent in a managed session thread, not an unrelated channel
