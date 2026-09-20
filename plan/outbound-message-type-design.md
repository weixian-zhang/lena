# Outbound Message Type Design

Reference notes distilled from the Hermes agent gateway (`hermes-agent/gateway/`).
Describes how a backend agent classifies and delivers the different kinds of
messages it sends to a chat client, and how the return path tells an approval
answer apart from ordinary chat text.

---

## Core principle

**There is no type discriminator on the wire.**

The backend never stamps an outbound message with `{"type": "approval"}`. Instead:

- **Outbound** — the *method invoked* is the type. Every method returns the same
  `SendResult` struct.
- **Inbound** — the type is recovered from either a **callback-id prefix**
  (button taps) or a **session-keyed pending-state registry** (typed replies).

This keeps the transport dumb and platform-agnostic. Telegram renders an
`InlineKeyboardMarkup`, Slack renders Block Kit, Discord renders an embed + View,
and a plain-text platform renders a numbered list — all from the same call.

---

## Outbound message types

| # | Type | Method | What it is | User's expected action |
|---|---|---|---|---|
| 1 | **Chat text** | `send()` | The agent's normal reply. | Read / reply freely |
| 2 | **Streaming partial** | `edit_message()` / `send_draft()` | Same reply, delivered token-by-token then finalized in place. | None — it becomes #1 |
| 3 | **Interim commentary** | `interim_assistant_callback` | Short assistant prose between tool calls ("Let me check that…"). | None |
| 4 | **Ephemeral notice** | returns `EphemeralReply` | System notice ("✨ New session started") that self-deletes after a TTL. | None |
| 5 | **Ask user (clarify)** | `send_clarify()` | Agent needs missing info. Two modes: multi-choice buttons + "Other", or an open-ended question. | Tap a choice, or type an answer — **blocks the agent** |
| 6 | **Approval (exec)** | `send_exec_approval()` | A dangerous shell command is gated. | Allow Once / Session / Always / Deny — **blocks the agent** |
| 7 | **Confirm (slash)** | `send_slash_confirm()` | An expensive or destructive command wants acknowledgement (`/new`, `/reset`, `/undo`, `/reload-mcp`). | Approve Once / Always Approve / Cancel |
| 8 | **Confirm (update)** | `send_update_prompt()` | `hermes update` needs input mid-upgrade. | Yes / No |
| 9 | **Selection (picker)** | `send_model_picker()` | Two-step drill-down list: provider → model. | Pick one; message edits in place |
| 10 | **Media attachment** | `send_image` / `send_voice` / `send_video` / `send_document` / … | Files the agent produced, extracted from `MEDIA:` tags in the reply. | None |
| 11 | **Typing indicator** | `send_typing()` | "Hermes is typing…", refreshed every ~2s. | None |
| 12 | **Tool progress** | edited progress bubble | Live list of tools as they fire (`🔍 web_search: "…"`). | None |
| 13 | **Thinking** | `💬` bubble | Assistant scratch reasoning between tool calls. Off by default. | None |
| 14 | **Status** | `send_or_update_status()` | Transient state ("compressing context"), edited in place per status key. | None |
| 15 | **Heartbeat** | edited bubble | `⏳ Working — 6 min — running terminal`, every 3 min on long runs. | None |
| 16 | **Notice** | `notice_callback` → `send_private_notice()` | Out-of-band account signals (credits 90% used, access paused/restored). | Usually none |
| 17 | **Lifecycle** | `send()` with non-conversational metadata | Restart/startup/update-complete, auto-reset notice, background-process completion. | None |

### Grouping

- **Conversational** (1–4) — the actual answer. Free-form text back.
- **Blocking prompts** (5–6) — the agent worker thread is parked on a
  `threading.Event` awaiting a decision. Clarify = *ask user for info*;
  approval = *ask user for permission*.
- **Non-blocking prompts** (7–9) — a choice is needed but nothing is stuck;
  resolution fires a stored handler.
- **Ambient** (10–17) — one-way. Wrapped in `_non_conversational_metadata(...)`
  so platforms can mute push notifications and keep them out of the reply thread.

Only types **5–9** ever expect a response.

---

## Uniform structs

```python
@dataclass
class SendResult:                 # uniform outbound ack for EVERY send_* method
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None
    raw_response: Any = None
    retryable: bool = False
    retry_after: Optional[float] = None
    continuation_message_ids: tuple = ()
    error_kind: Optional[str] = None   # too_long|bad_format|forbidden|not_found
                                       # |rate_limited|transient|unknown

@dataclass
class MessageEvent:               # uniform inbound event
    text: str
    message_type: MessageType = MessageType.TEXT   # TEXT|PHOTO|VOICE|VIDEO|DOCUMENT|…
    source: SessionSource = None
    message_id: Optional[str] = None
    media_urls: List[str]; media_types: List[str]
    reply_to_message_id / reply_to_text / reply_to_is_own_message
    internal: bool = False        # synthetic system event — bypasses auth
    metadata: Dict[str, Any]
    timestamp: datetime
```

`MessageType` describes **media kind**, not intent — a typed `/approve` and
"what's the weather" are both `MessageType.TEXT`.

---

## Discriminator #1 — session-keyed pending registries

Before any prompt is sent, a pending record is registered. **That record is what
makes the message an approval**; the chat message is only its rendering.

```python
# Exec approval — blocks the agent's worker thread
class _ApprovalEntry:
    event: threading.Event                  # agent thread blocks here
    data: dict                              # command, description, pattern_keys,
                                            # allow_permanent, smart_denied
    result: Optional[str]                   # "once" | "session" | "always" | "deny"
    reason: Optional[str]                   # free text from `/deny <reason>`
_gateway_queues: dict[str, list[_ApprovalEntry]]     # session_key → FIFO queue

# Clarify — also blocking
@dataclass
class _ClarifyEntry:
    clarify_id: str; session_key: str
    question: str; choices: Optional[List[str]]
    event: threading.Event
    response: Optional[str]
    awaiting_text: bool                     # open-ended, or user tapped "Other"
_entries: Dict[str, _ClarifyEntry]          # clarify_id → entry (button lookup)
_session_index: Dict[str, List[str]]        # session_key → [clarify_id] (text FIFO)

# Slash confirm — non-blocking, stores an async handler
_pending: Dict[str, Dict] = {
    session_key: {"confirm_id": str, "command": str,
                  "handler": Callable[[str], Awaitable], "created_at": float}
}   # one per session; a new confirmable command supersedes the stale one
```

Timeouts: approval ≈ 5 min, clarify per config, slash-confirm 300 s stale window.

---

## Discriminator #2 — callback-id prefix namespace

Button taps never become a `MessageEvent`. They arrive as a platform callback
query and route purely by string prefix:

```
ea:<choice>:<id>          exec approval      → resolve_gateway_approval
cl:<clarify_id>:<idx>     clarify            → resolve_gateway_clarify
sc:<choice>:<confirm_id>  slash confirm      → slash_confirm.resolve
mp:|mg:|mpv:|mc:|mm:|mpg: model picker       → model-picker callback
update_prompt:y|n         update prompt      → response file
gt:<verb>:<arg>           domain skill       → skill handler
```

Approval taps are **re-authorized** at click time — a button posted in a group
must not let a non-allowlisted member approve a destructive command.

---

## Discriminator #3 — text-fallback intercept ladder

On platforms without buttons the user just types, so intent is resolved by a
fixed priority ladder before anything reaches the agent:

```mermaid
flowchart TD
    A[MessageEvent] --> B{update prompt pending?}
    B -->|yes, and not a known slash cmd| B1[→ write update response]
    B -->|no| C{clarify pending?}
    C -->|yes, and text doesn't start with /| C1[→ resolve clarify]
    C -->|no| D{slash-confirm pending<br/>AND no blocking approval?}
    D -->|yes| D1[map /approve /always /cancel → handler]
    D -->|no| E{agent currently running?}
    E -->|yes| E1[/approve /deny /stop /new /queue /steer bypass;<br/>other cmds rejected; plain text interrupts or queues]
    E -->|no| F{recognized slash command?}
    F -->|yes| F1[command dispatch]
    F -->|no| G[quick / plugin / skill commands]
    G --> H[agent turn]
```

Three ordering rules encode the policy:

1. **Tool approval outranks slash-confirm.** Gate is
   `if _pending_confirm and not _tool_approval_live` — when an approval is
   blocking a thread, a typed `/approve` must unblock *that thread*.
2. **Slash commands escape clarify and update prompts.** A pending clarify is
   skipped when the text starts with `/`, so `/stop` still works while a question
   is outstanding.
3. **`/approve` and `/deny` bypass both message guards.** The adapter queues
   messages while a session is active and the runner would otherwise call
   `interrupt()` — neither unblocks a thread parked on a `threading.Event`, so
   these are dispatched inline.

---

## "Ask the user" is a tool call, not a special message

Type #5 (clarify) is unusual: it is not something the backend decides to send —
**the model asks for it** by calling a normal tool named `clarify`. There is no
separate `ask_user` tool.

### The tool the model sees

```json
{
  "name": "clarify",
  "description": "Ask the user a question when you need clarification, feedback, or a decision before proceeding.",
  "parameters": {
    "type": "object",
    "properties": {
      "question": { "type": "string",
                    "description": "The question itself, and ONLY the question." },
      "choices":  { "type": "array", "items": {"type": "string"}, "maxItems": 4,
                    "description": "Selectable options. Omit entirely for open-ended free text." }
    },
    "required": ["question"]
  }
}
```

A call looks like:

```json
{"name": "clarify",
 "arguments": {"question": "Which deployment target?", "choices": ["staging", "prod"]}}
```

### The handler is deliberately thin

```python
def clarify_tool(question, choices=None, callback=None) -> str:
    # 1. validate + normalize (trim to 4 choices; empty list → open-ended)
    # 2. delegate the ACTUAL UI to a platform-injected callback
    user_response = callback(question, choices)      # ← BLOCKS the agent thread
    # 3. wrap the answer as a normal tool result
    return json.dumps({"question": question,
                       "choices_offered": choices,
                       "user_response": user_response})
```

The tool owns the **schema and contract**; each surface owns the **UI**. The
executor injects the right callback at call time (`callback=agent.clarify_callback`):

| Surface | Rendering |
|---|---|
| CLI | arrow-key selectable panel |
| Gateway (chat) | `adapter.send_clarify()` → buttons, or numbered text list |
| TUI | Ink prompt component |
| One-shot | stdin |
| Leaf subagents | `callback=None` → tool returns "not available" (no user to ask) |

### End-to-end flow on a chat platform

1. Model emits the `clarify` tool call.
2. Callback registers a `_ClarifyEntry` (with a `threading.Event`) keyed by
   `clarify_id`, then schedules `adapter.send_clarify(...)`.
3. **The agent's worker thread blocks** on `wait_for_response(clarify_id, timeout)`.
4. User taps a button (`cl:<id>:<idx>`) or types a reply (caught by the intercept
   ladder) → the event is set.
5. The answer is returned, wrapped as JSON, and the agent loop continues with it
   as an ordinary tool result. On timeout it returns
   `"[user did not respond within Nm]"` instead of hanging.

### Why clarify and approval stay separate

The tool description explicitly steers the model away from overlap:

> *Do NOT use this tool for simple yes/no confirmation of dangerous commands
> (the terminal tool handles that). Prefer making a reasonable default choice
> yourself when the decision is low-stakes.*

- **Clarify** — the agent *lacks information*. Model-initiated, via a tool call.
- **Approval** — the agent *has permission-gated intent*. System-initiated, by
  the danger classifier intercepting a command before it runs.

Both block the same way, but they are triggered by different actors and must not
be merged.

---

## Design invariants worth carrying forward

- **No bare-text approval.** `"yes"` in conversation never approves anything.
  Only an explicit `/approve` / `/deny` or a button tap resolves an approval.
- **Graceful degradation.** Every interactive method has a plain-text fallback,
  so a platform with no button support still gets a usable flow (numbered list,
  typed `/approve` / `/always` / `/cancel`).
- **One ack struct.** All 17 types return `SendResult`, so retry, splitting, and
  failure classification live in one place.
- **Ambient vs conversational separation.** Progress, status, heartbeat, and
  lifecycle messages carry non-conversational metadata so they can be muted and
  excluded from reply threading without touching the agent.
- **Prompt state is server-side.** The client holds no prompt state; a restart
  or a client swap does not orphan a decision — the registry is the truth.
- **Asking the user is a tool, not a message type.** Clarify enters through the
  model's tool schema; the UI layer only renders it. Adding a new surface means
  writing one callback, not touching the agent.
