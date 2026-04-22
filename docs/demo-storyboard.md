# Demo Storyboard

Use this script to record a short CodeHelm demo for the README or release notes.

## Target Length

- 60 to 90 seconds for a README video
- 10 to 20 seconds for a looping preview GIF

## What The Demo Should Prove

The viewer should understand four things quickly:

- CodeHelm is started locally
- Codex connects to the printed `ws-url`
- Discord controls the session lifecycle
- approvals and final output stay in the same Discord thread

## Suggested Capture Sequence

### 1. Start CodeHelm

Capture a terminal running:

```bash
code-helm start
```

Pause long enough to show:

- startup succeeded
- the printed `ws-url`
- the bot is connected

### 2. Connect Codex

Capture a second terminal running:

```bash
codex --remote <ws-url>
```

If you want the demo to show an explicit workdir handoff, use:

```bash
codex -C "$(pwd)" --remote <ws-url>
```

### 3. Set the workdir and open or resume a session from Discord

In Discord, show:

- the configured control channel
- `/workdir`
- either `/session-new` or `/session-resume`

The important moment is the new managed thread appearing from the control channel flow.

### 4. Trigger one approval

In the managed session thread, show one request that needs approval and approve it from Discord.

Good approval examples:

- a command approval
- a permissions approval
- a file-change approval

Keep the example short enough that the approval UI is easy to read in the recording.

### 5. Show progress and the final answer

Stay in the same Discord session thread long enough to show:

- progress updates
- the final answer
- the fact that the conversation stayed inside one managed thread

## README Asset Suggestions

For the README video link:

- use the full 60 to 90 second walkthrough
- keep terminal text readable at normal browser size

For the README preview image or GIF:

- use the Discord thread view, not only the terminal
- include one approval state or one final answer frame
- crop tightly enough that the managed thread is the focus
