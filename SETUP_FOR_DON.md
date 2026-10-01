# GCE DON CONTROL BAR v1 — SETUP (for Don)

Built by Nico. Ready for you to load. Luce is verifying separately; this page is
just for getting it on screen.

---

## 1. WHERE IT IS

```
C:\Users\Dekan AI Brother\GCE_DON\command-center\control-bar\extension
```

That folder is the extension. Don't move it — Floorp loads it from that exact spot.

---

## 2. LOAD IT INTO FLOORP

1. Open Floorp.
2. Type `about:debugging` in the address bar and hit Enter.
3. Find the **This Firefox** section on the right.
4. Click **Load Temporary Add-on…**
5. Pick `manifest.json` out of the `extension` folder above.

That's it. No signing, no store, no install button.

> **Temporary = it disappears when you close Floorp.** That's intentional for v1.
> Next time you open Floorp, do steps 2–5 again. Making it permanent needs a
> signed build, which is out of scope for v1.

---

## 3. OPEN THE CONTROL BAR

- **View → Sidebar** (or click the sidebar icon in the toolbar).
- Pick **GCE Don Control Bar** if the sidebar has a list.

You should see a small dark panel with seven buttons:

```
┌──────────────┬──────────────┐
│  Bootstrap   │  Re-Center   │
├──────────────┼──────────────┤
│    Frame     │    State     │
├──────────────┼──────────────┤
│    Anchor    │   Handoff    │
├──────────────┴──────────────┤
│            End              │
└─────────────────────────────┘
```

**Also open a ChatGPT tab** (`https://chatgpt.com`). The control bar needs a
ChatGPT tab to talk to. Without one, pressing a button will say
`FAILED — NOT SENT`, which is the correct behaviour, not a bug.

---

## 4. THE SEVEN BUTTONS

Each one sends a single command into the ChatGPT conversation. It does not
interpret the reply — Coda does that.

| Button | Command | What Coda is being asked to do |
|---|---|---|
| **Bootstrap** | `RELOAD_BOOTSTRAP` | Make sure its governing Bootstrap is loaded and current. Safe to press twice. |
| **Re-Center** | `RECENTER_SESSION` | Keep what was accepted, Don's decisions, committed anchors, your intent and objective. Cut the unanchored drift and any unsupported "I already did it" claims. |
| **Frame** | `REASSERT_FRAME` | Re-assert the canonical Session Header/Footer contract. |
| **State** | `SHOW_STATE` | Read-only. Report current session state back. |
| **Anchor** | `ANCHOR_COMMIT` | Create a session checkpoint anchor. This does **not** promote anything to Framework canon — that's a separate decision you make through Coda. |
| **Handoff** | `CREATE_HANDOFF` | Produce the handoff artifact from accepted session state. |
| **End** | `END_SESSION` | Close the session: footer plus final bookend anchor. |

**One command per message.** Each press sends exactly one clean command block as
the entire message. Nothing else is added to it.

---

## 5. SHORTCUTS

Once the sidebar is open and a ChatGPT tab is focused:

```
Ctrl+Alt+1   Bootstrap        Ctrl+Alt+5   Anchor
Ctrl+Alt+2   Re-Center        Ctrl+Alt+6   Handoff
Ctrl+Alt+3   Frame            Ctrl+Alt+7   End
Ctrl+Alt+4   State
```

---

## 6. WHAT THE LIGHTS MEAN

Top-right of the panel:

| Shows | Means |
|---|---|
| `IDLE` | Nothing outstanding. Normal resting state. |
| `PENDING` | Command sent, waiting for Coda's acknowledgement. |
| `ACCEPTED` | Coda acknowledged it. This is the only "success" that counts. |
| `PARTIAL` | Coda did some of it. Read the NOTE line. |
| `REJECTED` | Coda declined it. |
| `AMBIGUOUS_STATE` | Coda can't tell preserved state from drift. It stopped and is asking you. **It will not guess.** |
| `FAILED — NOT SENT` | Never left the machine. Nothing was transmitted. |
| `NO ACTIVE SEAT` | Session is closed. Press **NEW SESSION** to start a new one. |

**Important:** the bar never shows success just because text got typed into the
box. Success only appears when Coda's acknowledgement arrives, matched to that
exact command. If it says PENDING and stays PENDING, Coda's side isn't answering
yet — that's a real state, not a glitch.

Under the status line you'll see the last state Coda sent, plus **STATE AGE** —
how stale it is. It never invents state; if nothing has come back it says
`NO STATE RECEIVED`.

**LOG** button (bottom) shows the full append-only history: what went out, what
came back, and anything that was **discarded** as unverified. That discard list
is the tamper log — random or copied `[GCE-ACK]` text from the page cannot change
the control bar unless it carries a nonce this bar actually issued.

---

## 7. FIRST LOAD IS ALSO THE OPEN TEST

One honest caveat. I could not get a live browser run to work in this
environment (Floorp kept asking for human verification), so three things are
built but **not yet proven on your machine**:

1. the sidebar renders and stays open,
2. `Ctrl+Alt+1..7` actually fire,
3. the control bar finds the ChatGPT composer on the live page.

So when you load it, please check those three. If any of them misbehaves, that
is a real failure and I want to know — the fix is a small edit to the ChatGPT
adapter or the manifest, not a redesign. Don't sit on it.

**Expect `PENDING` and not much else on the first presses** until Coda's side is
live and replying with `[GCE-ACK v1]` blocks. The bar is only the emitter and the
status board; the other half of the conversation is Coda's.

---

## 8. IF SOMETHING'S WRONG

| Symptom | Likely cause |
|---|---|
| `Load Temporary Add-on` greyed out | You're on `about:addons`, not `about:debugging` |
| Sidebar doesn't appear | View → Sidebar, then pick "GCE Don Control Bar" from the list |
| `FAILED — NOT SENT` | No ChatGPT tab open, or the composer wasn't found on the page |
| `PENDING` forever | Command went out, no ACK back. Coda's side isn't answering yet |
| All buttons dead, `NO ACTIVE SEAT` | Session closed. Press **NEW SESSION** |
| Extension gone after closing Floorp | Expected — temporary install. Load it again |
| Shortcut does nothing | Sidebar not focused, or the shortcut got claimed by something else |

---

## 9. THE ONE RULE

The control bar carries **zero GCE command meaning**. It doesn't know what
Bootstrap or Anchor or Handoff actually *mean*, doesn't judge your session, and
doesn't calculate confidence. It sends the command, and it shows you what Coda
said. All the thinking stays where it belongs — with Coda.

That boundary is deliberate. If ChatGPT's page layout ever changes, one small
adapter file gets replaced and nothing else moves.

---

**Questions or anything that looks wrong → Nico.**
**Independent verification → Luce.**
