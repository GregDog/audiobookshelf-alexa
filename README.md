# audiobookshelf-alexa

A personal-use Alexa skill that streams audiobooks from a self-hosted
[audiobookshelf](https://www.audiobookshelf.org/) instance.

It runs on AWS Lambda (Node.js 22) and uses Alexa's `AudioPlayer`
interface to stream tracks directly from your audiobookshelf server.
Playback progress is synced back to audiobookshelf so it stays in sync
with the web/mobile apps.

> 🇩🇪 **Deutsche Version weiter unten** — siehe [Deutsche Anleitung](#deutsche-anleitung).

---

# English

## Features

The default **invocation name** is `my audiobooks` (English) and
`meine hörbücher` (German) — change it in
`skill-package/interactionModels/custom/*.json` if you want
something else, but pick a multi-word phrase that Alexa's speech
recognition can transcribe (single English words like
"audiobookshelf" don't work in German voice mode).

- **Launch** — `Alexa, open my audiobooks`.
- **Play by title** — `play <title>`. Searches the library, picks the
  top hit, and resumes from saved progress if the book was already
  started.
- **Continue** — `continue` resumes the most recently played
  in-progress audiobook. `continue <title>` resumes a specific one.
- **In-progress list** — `what am I listening to?` lists the top five.
- **Chapter navigation** — `next` jumps to the next chapter;
  `previous` jumps to the previous. Uses audiobookshelf's
  `media.chapters[]`, not file boundaries.
- **Time-based seek** — `skip 30 seconds back`,
  `skip 5 minutes forward`.
- **Sleep timer** — `set a sleep timer for 30 minutes`. Cancel with
  `cancel sleep timer`. The deadline is encoded in the AudioPlayer
  token; playback stops at the end of the next track that finishes
  after the deadline (i.e. up to one track length of overshoot — no
  external scheduler required).
- **Listing** — `list my libraries`, `what is new?` for recently added
  books.
- **Standard transport** — `pause`, `resume`, `stop`. Hardware
  Next/Previous buttons (`PlaybackController.*`) map to chapter skip.
- **en-US and de-DE locales.**

## Prerequisites

1. An audiobookshelf instance reachable from the public internet over
   **HTTPS** with a valid certificate. Alexa's AudioPlayer fetches stream
   URLs directly from your server, so it cannot be on a private LAN.
2. An audiobookshelf **API key**: in the web UI go to *Settings → Users
   → API Keys*, create one for the user account you want to use, and
   copy the JWT it shows once.
3. An [Amazon Developer](https://developer.amazon.com/alexa) account and
   an AWS account.
4. Either the [ASK CLI](https://developer.amazon.com/en-US/docs/alexa/smapi/quick-start-alexa-skills-kit-command-line-interface.html)
   (`npm i -g ask-cli`) or willingness to copy/paste files into the
   developer console and zip up the Lambda by hand.

## Layout

```
.
├── skill-package/                 # Alexa skill manifest + interaction models
│   ├── skill.json
│   └── interactionModels/custom/{de-DE,en-US}.json
├── lambda/                        # AWS Lambda backend
│   ├── index.js                   # Skill entry point and intent handlers
│   ├── lib/
│   │   ├── absClient.js           # audiobookshelf HTTP client
│   │   ├── playback.js            # AudioPlayer token + offset helpers
│   │   └── strings.js             # Localized response strings
│   └── test/                      # node:test unit tests
├── ask-resources.json             # ASK CLI deployment config
└── .env.example                   # Required Lambda env vars
```

## Step-by-step installation (for first-timers)

This walkthrough takes you from "I have audiobookshelf running at home"
to "Alexa plays my audiobooks", assuming you've never touched AWS or the
Alexa Developer Console. Plan for **about 60–90 minutes** the first
time. AWS Free Tier covers a personal skill; you should pay $0/month
unless you set something else up at AWS.

You'll create accounts on three services along the way: an Amazon
Developer account (Alexa skills), an AWS account (Lambda hosting),
and — if you don't already have public HTTPS — possibly Cloudflare
(free tunnel). Use the **same email address** for the Amazon and
Alexa accounts; Echo devices are linked by Amazon account.

### Step 1 — Make audiobookshelf reachable from the internet over HTTPS

Alexa runs in Amazon's cloud and downloads each track directly from
your audiobookshelf server. That means your server must be reachable
from the public internet at a `https://...` URL with a valid TLS
certificate (self-signed certs do **not** work). It does not need to be
fast — Alexa buffers — but it must be reachable.

If your audiobookshelf is already at e.g. `https://abs.yourdomain.com`,
skip to step 2. Otherwise pick one of these options:

**Option A — Cloudflare Tunnel (recommended for beginners).** Free, no
port forwarding, automatic HTTPS. Requires a domain you own (any
registrar is fine; cheapest is `~$10/year`). Walkthrough:
<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/>.
After setup you'll have something like
`https://abs.yourdomain.com → http://localhost:13378` (or whatever
port your audiobookshelf listens on internally).

**Option B — Reverse proxy with Let's Encrypt.** Nginx/Caddy/Traefik
in front of audiobookshelf, with a real domain pointed at your home IP
(plus port forwarding 443→reverse-proxy on your router). More moving
parts than option A and you have to keep your IP up-to-date with a
dynamic DNS provider unless your ISP gives you a static one.

**Option C — VPS in front of audiobookshelf.** Rent a $5/month VPS
(Hetzner, DigitalOcean, …), run a reverse proxy there, and connect it
to your home server via Tailscale or WireGuard. Simplest if you don't
have a usable home network.

**Test:** from any device outside your home network, open
`https://your-abs-url/ping` in a browser. You should see `pong` (or
similar). If you get a certificate warning, fix that before continuing
— Alexa rejects untrusted certificates.

> **Security note.** Once your audiobookshelf is on the public
> internet, anyone who guesses your URL can hit the login page. Make
> sure each user account has a strong password. The skill itself uses
> an API key (next step), not a password — keys can be revoked
> instantly without changing your password.

### Step 2 — Create an audiobookshelf API key

1. Log in to your audiobookshelf web UI as an **admin** user.
2. Click your username (top-right) → **Settings**.
3. Open **Users**, click your user, then the **API Keys** tab.
4. **Create API Key**:
   - Name: `Alexa` (or anything memorable)
   - User: your own user
   - Expiration: leave empty for "never" (you can always revoke it)
   - Make sure it's **enabled**
5. Click **Create**. The key appears **once** — copy it now and put it
   in a password manager. It looks like a long `eyJhbGc...` string.

You'll paste this into AWS in step 7.

### Step 3 — Install Node.js on your computer

You need Node.js to install the skill's dependencies. Get **Node.js
20 or later** (LTS recommended) from <https://nodejs.org/>. Any
version from 20.x onward works for local install/test (Lambda runs
with a pinned runtime regardless). Verify in a terminal:

```bash
node --version    # should print v20.x.y or higher
npm --version     # should print 10.x.y or similar
```

### Step 4 — Get this repository onto your machine

```bash
git clone https://github.com/<your-fork-or-this-repo>/audiobookshelf-alexa.git
cd audiobookshelf-alexa
cd lambda
npm install
npm test    # should print "45 pass" — proves the code works on your machine
cd ..
```

If `npm test` fails, fix that before continuing. Don't try to deploy
broken code.

### Step 5 — Create an AWS account (if you don't have one)

1. Go to <https://aws.amazon.com/free/> and click **Create a Free
   Account**. You'll need a credit card; AWS does not charge for the
   Free Tier, but a card is required for verification.
2. Pick the region you want everything to live in. **`us-east-1`
   (N. Virginia)** is the right choice for English- and
   German-language skills — Alexa Skills Kit is wired to that region
   for those locales. Stick with `us-east-1` everywhere below.
3. Once your account is active, sign in to the **AWS Console**
   <https://console.aws.amazon.com/>.

> **Cost expectation.** A personal skill makes a few hundred Lambda
> requests per month. AWS Free Tier covers 1,000,000 Lambda
> requests/month forever. You should see $0 charges. Set up a
> [billing alarm](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/monitor_estimated_charges_with_cloudwatch.html)
> for $1 just to sleep well at night.

### Step 6 — Create the Lambda function

1. In the AWS Console, switch to region **N. Virginia (us-east-1)**
   (top-right region picker).
2. Search for **Lambda** in the top search bar; open the Lambda
   service.
3. Click **Create function**.
4. Choose **Author from scratch**.
5. Fill in:
   - **Function name:** `audiobookshelf-alexa`
   - **Runtime:** `Node.js 22.x` (the current LTS at time of writing;
     `Node.js 20.x` also works if it's still available)
   - **Architecture:** `x86_64` (default)
   - **Permissions:** leave at "Create a new role with basic Lambda
     permissions"
6. Click **Create function**.

Give it a minute. You'll land on the function's overview page.

### Step 7 — Upload the Lambda code as a ZIP

On your computer (macOS / Linux / WSL / Git Bash):

```bash
cd lambda
npm install                # if you haven't yet
zip -r ../audiobookshelf-alexa.zip . -x "test/*"
cd ..
```

On Windows PowerShell (no `zip` command by default):

```powershell
$src = "lambda"
$dst = "audiobookshelf-alexa.zip"
$temp = Join-Path $env:TEMP "abs-alexa-pkg"
if (Test-Path $dst) { Remove-Item $dst -Force }
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
New-Item -ItemType Directory -Path $temp | Out-Null
Get-ChildItem -Path $src -Exclude "test" | Copy-Item -Destination $temp -Recurse -Force
Compress-Archive -Path (Join-Path $temp "*") -DestinationPath $dst -Force
Remove-Item $temp -Recurse -Force
```

Either way you end up with `audiobookshelf-alexa.zip` next to the
`lambda/` folder containing `index.js`, `lib/`, `node_modules/`, and
`package.json` (about 200–300 KB).

In the AWS Console, on the Lambda function page:

1. Scroll to the **Code** section.
2. Click **Upload from** → **.zip file** → **Upload**.
3. Choose `audiobookshelf-alexa.zip`. Wait for the upload to finish
   (a few seconds for ~5 MB).
4. Once it's loaded you should see `index.js` in the in-browser
   editor.

Now the **handler setting** must match `index.handler`:

1. Scroll down to the **Runtime settings** panel and click **Edit**.
2. Set **Handler** to `index.handler`. (This is the default; verify
   it.)
3. Save.

### Step 8 — Set the environment variables

Still on the Lambda function page:

1. Click the **Configuration** tab.
2. Click **Environment variables** in the left side panel.
3. Click **Edit** → **Add environment variable** twice:
   - `ABS_BASE_URL` = your audiobookshelf URL, **no trailing slash**
     (e.g. `https://abs.yourdomain.com`)
   - `ABS_API_KEY` = the API key you copied in step 2. Used as the
     household default — every Echo hits this audiobookshelf user
     unless you also configure `ABS_USERS` (see *Multi-user setup*
     below).
4. Optionally a third one if you have multiple libraries and want to
   pin one:
   - `ABS_DEFAULT_LIBRARY_ID` = the library ID (find it in the
     audiobookshelf URL when browsing a library)
5. For multiple audiobookshelf users sharing one Echo household, also
   add:
   - `ABS_USERS` = JSON object mapping each Alexa `deviceId` to its
     own API key, e.g.
     `{"amzn1.ask.device.AAA...":"key-alice","amzn1.ask.device.BBB...":"key-bob"}`.
     See *Multi-user setup* below for how to find a device's ID.
6. Click **Save**.

While you're in **Configuration**, also bump the function timeout —
the default 3 seconds is too tight for a cold-start Lambda calling
audiobookshelf:

1. **Configuration → General configuration → Edit**.
2. Set **Timeout** to `0 min 10 sec` (10 seconds).
3. **Save**.

### Step 9 — Add the Alexa Skills Kit trigger

This connects Alexa to the Lambda; the inverse wiring (Alexa skill →
Lambda ARN) happens in step 11.

1. Still on the Lambda function page, go to the **Configuration** tab.
2. Click **Triggers** → **Add trigger**.
3. Select **Alexa Skills Kit** from the dropdown.
4. Skill ID verification: pick **Disable** for now — you don't have a
   skill ID yet. Once you have one in step 10, come back here and
   paste it in.
5. Click **Add**.

Now copy the **function ARN** — it's at the top of the Lambda page,
looks like
`arn:aws:lambda:us-east-1:123456789012:function:audiobookshelf-alexa`.
You'll paste it in step 11.

### Step 10 — Create the Alexa skill

1. Go to <https://developer.amazon.com/alexa/console/ask> and sign in
   with the same Amazon account as your Echo. Accept the developer
   agreement if prompted.
2. Click **Create Skill**.
3. **Skill name:** `Audiobookshelf` (or anything you like — this is
   not the invocation name).
4. **Primary locale:** English (US) if you'll mostly speak English;
   German (DE) otherwise. You can add the other locale later.
5. **Experience type:** **Other → Custom**.
6. **Hosting:** **Provision your own** (you have a Lambda already).
7. **Template:** **Start from scratch**.
8. Click **Create skill** → wait a few seconds.

You'll land in the skill builder. Now upload the interaction model:

1. In the left sidebar, click **JSON Editor** under **Interaction
   Model**.
2. Open `skill-package/interactionModels/custom/en-US.json` (or
   `de-DE.json`) on your computer in a text editor, copy its full
   contents, and paste them into the JSON Editor, replacing whatever's
   there. (You can also drag-and-drop the file onto the editor.)
3. Click **Save Model** (top of page).
4. Click **Build Model** (also at the top). Wait ~30 seconds for the
   green checkmark.
5. If you want both locales: top-right language picker → add the other
   locale and repeat.

> **About the invocation name.** The shipped models use
> `my audiobooks` / `meine hörbücher` as the invocation name. If you
> change the `invocationName` field in the JSON, keep it to two or more
> common-language words — Amazon disallows single-word invocation
> names for non-brand skills, and Alexa's speech recognition handles
> multi-word phrases more reliably (especially in German, where
> "audiobookshelf" is transcribed as three separate words).

### Step 10b — Enable the AudioPlayer interface (REQUIRED)

This step is easy to miss but **the skill will not play audio
without it.** Without AudioPlayer enabled, your Echo will respond
with *"There was a problem with the requested skill's response"*
whenever you ask it to play a book.

1. Still in the Alexa skill builder, click **Interfaces** in the left
   sidebar (under **Build**).
2. Find the **Audio Player** row and toggle it **ON**.
3. Click **Save** (top of the page).
4. Click **Build skill** (top right) and wait for the green check —
   you'll need to rebuild any time you change interfaces, the model,
   or invocation name.

### Step 11 — Wire the skill to the Lambda

Still in the Alexa skill builder:

1. Click **Endpoint** in the left sidebar.
2. Choose **AWS Lambda ARN**.
3. **Default Region:** paste the Lambda function ARN from step 9.
4. (Skip the other regions unless you want failover.)
5. Click **Save Endpoints**. The console copies a **Skill ID** to the
   clipboard message and shows it on this page; copy it.

Now go back to the AWS Console → Lambda → your function →
Configuration → Triggers, and **edit** the Alexa Skills Kit trigger:

1. Switch **Skill ID verification** from Disable to **Enable**.
2. Paste the Skill ID.
3. Save.

This stops random people who somehow got your Lambda ARN from
invoking it.

### Step 12 — Enable testing and try it out

1. Back in the Alexa skill builder, click **Build** (top tab) →
   **Build Model** if you haven't yet. Wait for the green check.
2. Click **Test** (top tab). Switch the toggle at the top of the
   page from **"Off"** to **"Development"**. **This is required —
   without it your Echo doesn't see the skill.**
3. In the test simulator panel on the left, type:
   `open my audiobooks`.
4. You should hear/see the welcome message.
5. Try `continue` — Lambda returns an `AudioPlayer.Play` directive in
   the JSON Output panel.

> **The simulator can't play audio.** When the Lambda returns an
> `AudioPlayer.Play` directive, the Test simulator displays *"There
> was a problem with the requested skill's response"*. That message
> is the simulator's own limitation, **not** an actual error. Check
> the JSON Output panel — if you see a properly formed
> `AudioPlayer.Play` directive with a stream URL, the skill is
> working and the audio will play on a real Echo.

For real audio playback, talk to **a real Echo device on the same
Amazon account** as your developer console:

```
"Alexa, open my audiobooks"
"continue"
"Alexa, ask my audiobooks to play <book title>"
```

Skills in Development mode are automatically enabled on your own
Echo devices — no need to publish, no need to "install" anything in
the Alexa app.

> **First call is slow.** Cold-start of an idle Lambda + the round
> trip to audiobookshelf can take 4–6 seconds the first time you
> invoke an intent after a long pause. Subsequent calls are usually
> under 1 second. If your very first attempt times out (Alexa says
> "There was a problem"), wait 10 seconds and try again — the
> Lambda is warm now.

### Multi-user setup (optional)

By default the skill uses the single `ABS_API_KEY` for every Echo —
fine for a one-person household. If multiple people share a household
of Echos and each has their own audiobookshelf user (so progress,
"continue listening", and the in-progress list are kept separate),
you can map each Echo to a different audiobookshelf API key.

**How it works.** Every Alexa request includes a stable `deviceId` in
`context.System.device.deviceId`. The skill looks the deviceId up in
the optional `ABS_USERS` JSON env var; on a hit it uses that user's
API key, on a miss it falls back to `ABS_API_KEY` (the household
default), and if neither matches it speaks an error asking the admin
to add the device.

**Setup.**

1. Create one audiobookshelf API key per person (audiobookshelf web
   UI → Settings → Users → API Keys, on each user's account).
2. Find each Echo's `deviceId`:
   - In audiobookshelf, watch the Lambda's CloudWatch logs (Lambda →
     Monitor → View logs in CloudWatch) while you say
     "Alexa, open my audiobooks" on the target Echo. The
     `Audiobookshelf client init failed: ... deviceId: amzn1.ask.device.XXX`
     log line is printed for unmapped devices.
   - Alternatively, add a one-line `console.log('deviceId:', deviceIdOf(h))`
     in any handler and redeploy, or look at the request envelope in
     the Alexa Test simulator's JSON Input panel.
3. Add the `ABS_USERS` env var to the Lambda. Value is a JSON object
   mapping deviceId to API key:
   ```json
   {
     "amzn1.ask.device.AAA...kitchen": "eyJhbGc...key-alice",
     "amzn1.ask.device.BBB...bedroom": "eyJhbGc...key-bob"
   }
   ```
   (one line, no real newlines — paste it as a single string into the
   Lambda env var editor)
4. Optional: keep `ABS_API_KEY` set as a household-default fallback so
   any not-yet-mapped Echo still works. Drop it if you'd rather have
   unmapped Echos refuse to play.
5. **Save** and re-test on each Echo: "Alexa, open my audiobooks" →
   "what am I listening to?" should now return that Echo's user's
   in-progress list.

**Caveats.**

- This is per *device*, not per *person*. Anyone speaking to the
  kitchen Echo gets that Echo's mapped user. Alexa Voice Profiles
  could distinguish speakers but are not used here.
- The Alexa mobile app and some Echo Show "everywhere" surfaces
  expose less stable deviceIds. Set `ABS_API_KEY` as a sane default
  for those.
- Proper per-person separation (one Amazon account → one
  audiobookshelf user, regardless of which Echo) would require Alexa
  account linking via OAuth, which audiobookshelf does not natively
  speak.

### Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| **Echo: "There was a problem with the requested skill's response"** — but the skill opens fine and only fails on `continue` / `play …` | The **AudioPlayer interface is not enabled** for the skill. Go to the skill builder → **Interfaces** → toggle **Audio Player** ON → **Save** → **Build skill**. (See Step 10b.) |
| **Echo: "I don't know how to help you with that"** when you say "Alexa, open …" | Either (a) the skill's **Test toggle is "Off"** in the developer console (set to **Development**), or (b) the **invocation name** can't be transcribed by Alexa's speech recognition. Check the Alexa **voice history** (alexa.amazon.com → Activity → Voice history) to see what Alexa thought you said, and pick a multi-word invocation name that matches the transcription. |
| **Echo: "I could not reach your audiobookshelf server"** | API key is wrong, expired, or disabled. Re-create in audiobookshelf and update `ABS_API_KEY` in Lambda env. |
| **Echo: "This Echo is not mapped to an audiobookshelf user yet"** | Multi-user mode is on (`ABS_USERS` set) but this Echo's `deviceId` isn't in the map and no `ABS_API_KEY` fallback is configured. Read the `deviceId` from CloudWatch (`Audiobookshelf client init failed: ... deviceId: amzn1.ask.device.XXX`) and add it to `ABS_USERS`, or set an `ABS_API_KEY` household default. |
| **First playback request times out, second works** | Lambda cold start + slow upstream call; pre-warm with a quick `open my audiobooks` first, then issue the `continue`. Already mitigated by the 10 s timeout from Step 8. |
| **Skill responds in the wrong language** | The skill builder language doesn't match your Echo. Add the missing locale in the skill builder, or switch your skill's primary locale. Make sure your Echo's language matches under **Alexa app → Devices → \<Echo\> → Language**. |
| **Skill is not on your Echo at all** | The Echo and the developer console must use the **same Amazon account**. Check **Alexa app → More → Skills & Games → Your Skills → Dev** — the skill should appear there. If it doesn't, you used different accounts. |
| **`Lambda timeout` in CloudWatch logs** | Default Lambda timeout is 3 seconds; bump it to 10 s (Configuration → General configuration → Edit). |
| **`index.handler is undefined`** | The ZIP was built from the wrong directory. Re-run the `zip` command **from inside `lambda/`**, not from the repo root — `index.js` must be at the **root** of the ZIP. |
| **Audio plays for a few seconds, then stops** | Either Cloudflare/your reverse proxy doesn't support HTTP **range requests**, or the file isn't a format Alexa can stream (it must be MP3/AAC/M4A/OGG and served with a matching `Content-Type`). Test with `curl -I -H "Range: bytes=0-1023" "<stream-url>"` — you should get `206 Partial Content`. |
| **Wrong book is played, or `play <title>` says "couldn't find"** | Check what Alexa actually heard in your [voice history](https://www.amazon.com/alexa-privacy/apd/rvh) — Alexa often (a) drops umlauts, (b) mashes hyphenated words together, or (c) anglicizes endings. The skill's fuzzy fallback handles these; if it still misses, say the most distinctive word alone. For a book whose title is very generic, set up a more specific phrase by editing the audiobookshelf metadata or rename the file. |
| **`Alexa, next chapter` doesn't work, but `Alexa, next` does** | Expected. While AudioPlayer is playing, only built-in intents (NextIntent, PauseIntent, …) reach the skill. Use the short `next` / `previous` forms — they map to the same chapter-skip handler. |

CloudWatch is your friend. In the Lambda function page → **Monitor** →
**View logs in CloudWatch**, click the most recent log stream to see
`console.error` and `console.log` output from the handler. The
`AudioPlayer event:` lines tell you which AudioPlayer events the Echo
sent back and any error code.

### Re-deploying after code changes

Whenever you change anything in `lambda/` (Bash / WSL / Git Bash):

```bash
cd lambda
npm install        # only if you changed package.json
npm test           # always, before deploying
zip -r ../audiobookshelf-alexa.zip . -x "test/*"
cd ..
```

PowerShell equivalent (Windows):

```powershell
Push-Location lambda
npm install        # only if you changed package.json
npm test           # always, before deploying
Pop-Location
$temp = Join-Path $env:TEMP "abs-alexa-pkg"
if (Test-Path "audiobookshelf-alexa.zip") { Remove-Item "audiobookshelf-alexa.zip" -Force }
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
New-Item -ItemType Directory -Path $temp | Out-Null
Get-ChildItem -Path "lambda" -Exclude "test" | Copy-Item -Destination $temp -Recurse -Force
Compress-Archive -Path (Join-Path $temp "*") -DestinationPath "audiobookshelf-alexa.zip" -Force
Remove-Item $temp -Recurse -Force
```

Upload the new ZIP via Lambda → Code → **Upload from** → **.zip
file**. The Alexa skill model only needs re-uploading if you changed
`skill-package/`. After an interaction-model change, click **Build
Model** in the skill builder — and remember to also rebuild after
changing **Interfaces** or the invocation name.

If you change the AudioPlayer token shape (`lib/playback.js`), expect
already-running playback sessions to fail until they restart — older
tokens won't decode against the new code.

## Power-user shortcut: ASK CLI

If you're comfortable on the command line, the [ASK CLI](https://developer.amazon.com/en-US/docs/alexa/smapi/quick-start-alexa-skills-kit-command-line-interface.html)
collapses steps 6–11 into one command:

```bash
npm i -g ask-cli
ask configure       # one-time browser-based AWS + Alexa login
cd lambda && npm install && cd ..
ask deploy
```

`ask deploy` packages `lambda/`, creates/updates the Lambda function,
uploads the skill manifest and interaction models, and wires the
endpoint. Set `ABS_BASE_URL` and `ABS_API_KEY` on the Lambda once
afterwards (Lambda console → Configuration → Environment variables, or
`aws lambda update-function-configuration`).

## Development

```bash
cd lambda
npm install
npm test            # 45 tests across helpers, HTTP client, and the handler
node --check index.js
```

### Debugging without an Echo

`test/handler.test.js` invokes `exports.handler` directly with synthesized
Alexa request envelopes (Launch, IntentRequest, AudioPlayer events,
PlaybackController). The audiobookshelf API is stubbed via an in-memory
mock (`test/fixtures/abs-mock.js`), so the suite runs offline.

This is the only way to test the **AudioPlayer event flow** — the
Developer Console simulator and `ask dialog` don't fire
`AudioPlayer.PlaybackStarted` / `PlaybackNearlyFinished` /
`PlaybackStopped`, so the auto-enqueue and sleep-timer logic cannot be
verified there. The handler tests cover those events end-to-end:

```bash
npm test
```

Iteration loop: edit `index.js` → `npm test` → done.

For ad-hoc live testing against a real audiobookshelf instance, set
`ABS_BASE_URL` and `ABS_API_KEY` and call `lib/absClient.js` directly:

```js
const { fromEnv } = require('./lib/absClient');
const c = fromEnv();
c.listLibraries().then((r) => console.log(JSON.stringify(r, null, 2)));
```

## Voice-command cheat sheet

Alexa treats commands differently depending on whether your skill
is in an **active session** (you just said "open my audiobooks"
and Alexa is listening for follow-ups) or **AudioPlayer mode** (a
book is playing). During AudioPlayer mode only built-in intents
get routed to the skill without an explicit invocation — custom
phrases need the skill name.

| What you want | Active session | AudioPlayer mode (book playing) |
|---|---|---|
| Start a book | `play <title>` | `Alexa, ask my audiobooks to play <title>` |
| Continue last book | `continue` | not applicable (already playing) |
| Pause | `pause` | `Alexa, pause` |
| Stop | `stop` | `Alexa, stop` |
| Next chapter | `next chapter` / `next` | **`Alexa, next`** (built-in) |
| Previous chapter | `previous chapter` / `previous` | **`Alexa, previous`** (built-in) |
| Skip ±N seconds/minutes | `skip 30 seconds forward` | `Alexa, ask my audiobooks to skip 30 seconds forward` |
| Sleep timer | `set a sleep timer for 20 minutes` | `Alexa, ask my audiobooks sleep timer 20 minutes` |
| What's playing | `what am I listening to` | use Alexa app or pause first |

> **Why "next chapter" doesn't work bare while a book is playing.**
> Alexa Skills Kit only forwards a fixed list of built-in intents
> (`AMAZON.NextIntent`, `AMAZON.PreviousIntent`, `AMAZON.PauseIntent`,
> `AMAZON.StopIntent`, `AMAZON.ResumeIntent`, …) to the skill during
> AudioPlayer playback. Custom intents like `NextChapterIntent` only
> match when the skill is explicitly invoked. The good news: the
> built-in `Alexa, next` already does the chapter jump, because the
> skill maps `AMAZON.NextIntent` to the same handler as
> `NextChapterIntent`.

## Limitations / known gaps

- **Personal use only.** There is no Alexa account linking (OAuth).
  The skill picks an audiobookshelf user per *device* via `ABS_USERS`
  (see *Multi-user setup*) or falls back to a single `ABS_API_KEY`,
  but it cannot distinguish speakers within the same Echo. Don't
  publish this skill on the public Alexa store as-is.
- **Search is best-effort.** The skill first tries audiobookshelf's
  server-side search with several query variants (raw, dehyphenated,
  article-stripped, longest-keyword) and falls back to a local
  fuzzy match (3-gram score with substring bonus, umlaut/punctuation
  normalization) over the entire library if that fails. This catches
  Alexa's habit of mashing words together and English-y endings. If
  you have hundreds of books with very similar titles, the top result
  might still be wrong; in that case prefer the most distinctive
  word from the title.
- **Sleep timer overshoot** — the deadline is enforced at AudioPlayer
  event boundaries. Playback stops at the end of whichever track is
  nearly-finished after the deadline. For an audiobook with 30-minute
  files the timer can overshoot by up to one file; for files of a few
  minutes (typical chapter-per-file rips) the overshoot is small.
- **Progress sync** sends a heartbeat on AudioPlayer events; sub-second
  accuracy relative to the audiobookshelf web player is not guaranteed.
- **Continue picks the newest in-progress book** when no title is
  given. With many in-progress books, prefer `continue <title>` for
  predictability.

## Audiobookshelf API references

- API reference (notes itself as out-of-date but still the best
  starting point): <https://api.audiobookshelf.org/>
- API keys guide: <https://www.audiobookshelf.org/guides/api-keys/>
- Current API source of truth: the audiobookshelf server source itself
  at <https://github.com/advplyr/audiobookshelf>.

---

# Deutsche Anleitung

Ein Alexa-Skill für den Privatgebrauch, der Hörbücher von einer
selbst gehosteten [audiobookshelf](https://www.audiobookshelf.org/)-
Instanz streamt.

Er läuft auf AWS Lambda (Node.js 22) und nutzt Alexas
`AudioPlayer`-Schnittstelle, um Tracks direkt vom audiobookshelf-Server
zu streamen. Der Wiedergabefortschritt wird zurück an audiobookshelf
synchronisiert, sodass alles mit der Web-/Mobile-App in Sync bleibt.

## Funktionen

Der Standard-**Aufrufname** ist `meine hörbücher` (Deutsch) und
`my audiobooks` (Englisch) — änderbar in
`skill-package/interactionModels/custom/*.json`. Wähle eine
mehrwortige Phrase, die Alexas Spracherkennung sauber transkribieren
kann (einzelne englische Wörter wie "audiobookshelf" funktionieren im
deutschen Sprachmodus nicht).

- **Starten** — `Alexa, öffne meine hörbücher`.
- **Spielen nach Titel** — `Spiele <Titel>`. Durchsucht die
  Bibliothek, nimmt den besten Treffer und setzt am gespeicherten
  Fortschritt fort, falls das Buch schon begonnen wurde.
- **Weitermachen** — `Mache weiter` setzt das zuletzt gespielte
  laufende Hörbuch fort. `Mache mit <Titel> weiter` setzt ein
  bestimmtes fort.
- **Liste laufender Bücher** — `Welche Bücher höre ich gerade?` listet
  die fünf neuesten.
- **Kapitelnavigation** — `Nächstes Kapitel` springt zum nächsten;
  `voriges Kapitel` zum vorherigen. Nutzt audiobookshelfs
  `media.chapters[]`, nicht Dateigrenzen.
- **Zeitsprung** — `Spring 30 Sekunden zurück`,
  `Spring 5 Minuten vor`.
- **Sleep Timer** — `Stelle den Sleep Timer auf 30 Minuten`.
  Beenden mit `Sleep Timer aus`. Das Ablaufdatum steckt im
  AudioPlayer-Token; die Wiedergabe stoppt am Ende des nächsten Tracks,
  der nach Ablauf endet (also bis zu eine Tracklänge Überlauf — kein
  externer Scheduler nötig).
- **Listen** — `Liste meine Bibliotheken`, `Was ist neu?` für zuletzt
  hinzugefügte Bücher.
- **Standard-Steuerung** — `pause`, `weiter`, `stop`. Hardware-
  Next/Previous-Tasten (`PlaybackController.*`) springen Kapitel.
- **de-DE und en-US.**

## Voraussetzungen

1. Eine audiobookshelf-Instanz, die aus dem öffentlichen Internet
   über **HTTPS** mit gültigem Zertifikat erreichbar ist. Alexas
   AudioPlayer holt Stream-URLs direkt vom Server, kann also nicht im
   privaten LAN sein.
2. Ein audiobookshelf-**API-Key**: in der Web-UI unter *Settings →
   Users → API Keys* erstellen und das einmalig angezeigte JWT
   kopieren.
3. Ein [Amazon-Developer-Konto](https://developer.amazon.com/alexa)
   und ein AWS-Konto.
4. Entweder die [ASK CLI](https://developer.amazon.com/en-US/docs/alexa/smapi/quick-start-alexa-skills-kit-command-line-interface.html)
   (`npm i -g ask-cli`) oder die Bereitschaft, Dateien manuell in die
   Developer Console zu kopieren und die Lambda per Hand zu zippen.

## Schritt-für-Schritt-Installation (für Einsteiger)

Diese Anleitung führt dich von "audiobookshelf läuft zuhause" zu
"Alexa spielt meine Hörbücher", auch wenn du AWS oder die Alexa
Developer Console noch nie benutzt hast. Plane beim ersten Mal etwa
**60–90 Minuten** ein. Der AWS Free Tier deckt einen privaten Skill
ab — du solltest 0 €/Monat zahlen, sofern du nicht woanders etwas
anlegst.

Du legst unterwegs Konten bei drei Diensten an: ein Amazon-Developer-
Konto (Alexa-Skills), ein AWS-Konto (Lambda-Hosting) und — falls du
noch kein öffentliches HTTPS hast — eventuell Cloudflare (gratis
Tunnel). Verwende für Amazon und Alexa **dieselbe E-Mail-Adresse**;
Echo-Geräte sind ans Amazon-Konto gebunden.

### Schritt 1 — audiobookshelf per HTTPS aus dem Internet erreichbar machen

Alexa läuft in Amazons Cloud und lädt jeden Track direkt von deinem
audiobookshelf-Server. Das heißt, dein Server muss aus dem öffentlichen
Internet unter einer `https://...`-URL mit gültigem TLS-Zertifikat
erreichbar sein (selbstsignierte Zertifikate funktionieren **nicht**).
Schnell muss er nicht sein — Alexa puffert — aber erreichbar.

Wenn dein audiobookshelf bereits unter z. B.
`https://abs.deinedomain.de` läuft, springe zu Schritt 2. Sonst wähle
eine der folgenden Optionen:

**Option A — Cloudflare Tunnel (empfohlen für Einsteiger).** Gratis,
keine Portweiterleitung, automatisches HTTPS. Benötigt eine eigene
Domain (jeder Registrar geht; günstig ab ~10 €/Jahr). Anleitung:
<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/>.
Nach Setup hast du z. B.
`https://abs.deinedomain.de → http://localhost:13378` (oder
welcher Port intern läuft).

**Option B — Reverse Proxy mit Let's Encrypt.** Nginx/Caddy/Traefik
vor audiobookshelf, mit echter Domain auf deine Heim-IP (plus Port-
Forwarding 443→Reverse Proxy am Router). Mehr bewegliche Teile als
Option A, und du brauchst Dynamic DNS, falls deine ISP keine statische
IP gibt.

**Option C — VPS vor audiobookshelf.** 5-€/Monat-VPS (Hetzner,
DigitalOcean, …) mit Reverse Proxy mieten und per Tailscale oder
WireGuard mit dem Heimserver verbinden. Am simpelsten, wenn das
Heimnetz nicht mitspielt.

**Test:** Von einem Gerät außerhalb deines Heimnetzes
`https://deine-abs-url/ping` im Browser öffnen. Du solltest `pong`
(oder ähnliches) sehen. Bei Zertifikatswarnung erst die fixen, bevor
du weitermachst — Alexa lehnt nicht vertrauenswürdige Zertifikate ab.

> **Sicherheitshinweis.** Sobald audiobookshelf öffentlich erreichbar
> ist, kommt jeder, der die URL errät, an die Login-Seite. Sorge für
> starke Passwörter pro Benutzer. Der Skill nutzt einen API-Key
> (nächster Schritt), kein Passwort — Keys lassen sich sofort
> widerrufen, ohne das Passwort zu ändern.

### Schritt 2 — audiobookshelf-API-Key anlegen

1. Als **Admin** in der audiobookshelf-Web-UI einloggen.
2. Benutzername (oben rechts) → **Settings**.
3. **Users** öffnen, dein Benutzer anklicken, dann Tab **API Keys**.
4. **Create API Key**:
   - Name: `Alexa` (oder etwas Wiedererkennbares)
   - User: dein eigener Benutzer
   - Expiration: leer lassen für "nie" (du kannst jederzeit widerrufen)
   - Sicherstellen, dass er **enabled** ist
5. **Create** klicken. Der Key erscheint **einmalig** — sofort
   kopieren und in den Passwort-Manager. Sieht aus wie ein langer
   `eyJhbGc...`-String.

Den fügst du in Schritt 7 in AWS ein.

### Schritt 3 — Node.js installieren

Du brauchst Node.js, um die Skill-Abhängigkeiten zu installieren.
**Node.js 20 oder neuer** (LTS empfohlen) von <https://nodejs.org/>.
Jede Version ab 20.x funktioniert lokal (Lambda läuft ohnehin auf
einer fix gepinnten Runtime). Im Terminal prüfen:

```bash
node --version    # sollte v20.x.y oder höher zeigen
npm --version     # sollte 10.x.y oder ähnlich zeigen
```

### Schritt 4 — Repo klonen

```bash
git clone https://github.com/<dein-fork-oder-dieses-repo>/audiobookshelf-alexa.git
cd audiobookshelf-alexa
cd lambda
npm install
npm test    # sollte "45 pass" zeigen — beweist, dass der Code lokal läuft
cd ..
```

Wenn `npm test` fehlschlägt, das erst fixen — keinen kaputten Code
deployen.

### Schritt 5 — AWS-Konto anlegen (falls noch keins)

1. Auf <https://aws.amazon.com/free/> auf **Create a Free Account**.
   Eine Kreditkarte wird zur Verifikation benötigt; AWS belastet im
   Free Tier nichts.
2. Region wählen, in der alles laufen soll. **`us-east-1` (N. Virginia)**
   ist die richtige Wahl für englische und deutsche Skills — Alexa
   Skills Kit ist für diese Locales an die Region gebunden. Bleibe
   überall bei `us-east-1`.
3. Sobald das Konto aktiv ist, in der **AWS Console**
   <https://console.aws.amazon.com/> einloggen.

> **Kostenerwartung.** Ein privater Skill macht ein paar hundert
> Lambda-Requests pro Monat. Der AWS Free Tier deckt 1.000.000
> Lambda-Requests/Monat dauerhaft ab. Du solltest 0 € sehen. Stelle
> für die Nachtruhe einen
> [Billing-Alarm](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/monitor_estimated_charges_with_cloudwatch.html)
> bei 1 € ein.

### Schritt 6 — Lambda-Funktion erstellen

1. In der AWS Console oben rechts auf Region **N. Virginia
   (us-east-1)** wechseln.
2. Oben **Lambda** suchen und öffnen.
3. **Create function** klicken.
4. **Author from scratch** wählen.
5. Ausfüllen:
   - **Function name:** `audiobookshelf-alexa`
   - **Runtime:** `Node.js 22.x` (aktuelles LTS; `Node.js 20.x` geht
     auch, falls noch verfügbar)
   - **Architecture:** `x86_64` (Standard)
   - **Permissions:** "Create a new role with basic Lambda
     permissions" lassen
6. **Create function**.

Eine Minute warten — du landest auf der Übersicht der Funktion.

### Schritt 7 — Lambda-Code als ZIP hochladen

Auf dem Rechner (macOS / Linux / WSL / Git Bash):

```bash
cd lambda
npm install                # falls noch nicht geschehen
zip -r ../audiobookshelf-alexa.zip . -x "test/*"
cd ..
```

Auf Windows PowerShell (kein `zip` von Haus aus):

```powershell
$src = "lambda"
$dst = "audiobookshelf-alexa.zip"
$temp = Join-Path $env:TEMP "abs-alexa-pkg"
if (Test-Path $dst) { Remove-Item $dst -Force }
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
New-Item -ItemType Directory -Path $temp | Out-Null
Get-ChildItem -Path $src -Exclude "test" | Copy-Item -Destination $temp -Recurse -Force
Compress-Archive -Path (Join-Path $temp "*") -DestinationPath $dst -Force
Remove-Item $temp -Recurse -Force
```

So oder so liegt am Ende `audiobookshelf-alexa.zip` neben dem
`lambda/`-Ordner und enthält `index.js`, `lib/`, `node_modules/`
und `package.json` (ca. 200–300 KB).

In der AWS Console auf der Lambda-Seite:

1. Zum Bereich **Code** scrollen.
2. **Upload from** → **.zip file** → **Upload**.
3. `audiobookshelf-alexa.zip` auswählen. Upload abwarten (wenige
   Sekunden bei ~5 MB).
4. Nach dem Laden sollte `index.js` im Editor sichtbar sein.

Der **Handler** muss auf `index.handler` stehen:

1. Zum Bereich **Runtime settings** scrollen, **Edit**.
2. **Handler** auf `index.handler` setzen (Standard; bitte prüfen).
3. Speichern.

### Schritt 8 — Umgebungsvariablen setzen

Weiter auf der Lambda-Seite:

1. Tab **Configuration**.
2. Links **Environment variables**.
3. **Edit** → zweimal **Add environment variable**:
   - `ABS_BASE_URL` = audiobookshelf-URL, **ohne abschließenden Slash**
     (z. B. `https://abs.deinedomain.de`)
   - `ABS_API_KEY` = der in Schritt 2 kopierte API-Key. Wird als
     Haushalts-Standard verwendet — jedes Echo greift damit auf
     denselben audiobookshelf-Benutzer zu, sofern du nicht zusätzlich
     `ABS_USERS` setzt (siehe *Mehrbenutzer-Setup* unten).
4. Optional eine dritte, falls du mehrere Bibliotheken hast und eine
   festlegen willst:
   - `ABS_DEFAULT_LIBRARY_ID` = die Bibliotheks-ID (in der
     audiobookshelf-URL beim Browsen einer Bibliothek sichtbar)
5. Für mehrere audiobookshelf-Benutzer im selben Echo-Haushalt
   zusätzlich:
   - `ABS_USERS` = JSON-Objekt, das jede Alexa-`deviceId` auf einen
     eigenen API-Key abbildet, z. B.
     `{"amzn1.ask.device.AAA...":"key-alice","amzn1.ask.device.BBB...":"key-bob"}`.
     Wie man die Geräte-ID herausfindet, steht unter
     *Mehrbenutzer-Setup*.
6. **Save**.

Im Tab **Configuration** auch das Funktions-Timeout erhöhen — die
Standard-3-Sekunden sind für einen kalten Lambda-Aufruf gegen
audiobookshelf zu knapp:

1. **Configuration → General configuration → Edit**.
2. **Timeout** auf `0 min 10 sec` (10 Sekunden).
3. **Save**.

### Schritt 9 — Alexa-Skills-Kit-Trigger hinzufügen

Das verbindet Alexa mit Lambda; die Gegenrichtung (Alexa-Skill →
Lambda-ARN) folgt in Schritt 11.

1. Auf der Lambda-Seite Tab **Configuration**.
2. **Triggers** → **Add trigger**.
3. **Alexa Skills Kit** wählen.
4. Skill ID verification: vorerst **Disable** — du hast noch keine
   Skill-ID. Nach Schritt 10 hier nochmal rein und eintragen.
5. **Add**.

Jetzt den **Function ARN** kopieren — steht oben auf der Lambda-Seite,
sieht aus wie
`arn:aws:lambda:us-east-1:123456789012:function:audiobookshelf-alexa`.
Den fügst du in Schritt 11 ein.

### Schritt 10 — Alexa-Skill anlegen

1. Auf <https://developer.amazon.com/alexa/console/ask> einloggen,
   mit demselben Amazon-Konto wie dein Echo. Developer-Vereinbarung
   ggf. annehmen.
2. **Create Skill**.
3. **Skill name:** `Audiobookshelf` (oder beliebig — das ist nicht
   der Aufrufname).
4. **Primary locale:** German (DE), wenn du hauptsächlich Deutsch
   sprichst; English (US) sonst. Der andere Locale lässt sich später
   ergänzen.
5. **Experience type:** **Other → Custom**.
6. **Hosting:** **Provision your own** (Lambda hast du schon).
7. **Template:** **Start from scratch**.
8. **Create skill** → kurz warten.

Du landest im Skill Builder. Jetzt das Interaction Model hochladen:

1. Links **JSON Editor** unter **Interaction Model**.
2. `skill-package/interactionModels/custom/de-DE.json` (oder
   `en-US.json`) lokal im Editor öffnen, gesamten Inhalt kopieren und
   in den JSON Editor einfügen, vorhandenen Inhalt überschreiben.
   (Drag-and-Drop der Datei geht auch.)
3. **Save Model** (oben).
4. **Build Model** (auch oben). ~30 Sekunden auf den grünen Haken
   warten.
5. Für beide Locales: oben rechts Sprachwähler → anderen Locale
   hinzufügen, wiederholen.

> **Zum Aufrufnamen.** Das ausgelieferte `de-DE.json` nutzt
> `meine hörbücher` als Aufrufnamen. Das ist Absicht — Alexas
> deutsche Spracherkennung transkribiert "audiobookshelf" als drei
> Wörter ("audio book shelf") und matcht keinen Ein-Wort-Aufruf.
> Mehrwortige deutsche Phrasen bestehen außerdem die Zertifizierung,
> da Amazon Ein-Wort-Aufrufnamen für Nicht-Marken-Skills verbietet.
> Wenn du das `invocationName`-Feld änderst, bleib bei zwei oder
> mehr alltäglichen Wörtern.

### Schritt 10b — AudioPlayer-Schnittstelle aktivieren (PFLICHT)

Diesen Schritt vergisst man leicht, **ohne ihn spielt der Skill keinen
Ton.** Ohne aktivierten AudioPlayer antwortet Echo mit *"Bei der
Antwort des angeforderten Skill ist ein Problem aufgetreten"*, sobald
du ein Buch abspielen willst.

1. Im Skill Builder links **Interfaces** (unter **Build**).
2. Zeile **Audio Player** auf **ON**.
3. **Save** (oben).
4. **Build skill** (oben rechts), grünen Haken abwarten — nach jeder
   Änderung an Interfaces, Modell oder Aufrufnamen neu bauen.

### Schritt 11 — Skill mit Lambda verdrahten

Weiter im Skill Builder:

1. Links **Endpoint**.
2. **AWS Lambda ARN** wählen.
3. **Default Region:** den Lambda-Function-ARN aus Schritt 9 einfügen.
4. (Andere Regionen ignorieren, außer du willst Failover.)
5. **Save Endpoints**. Die Console zeigt eine **Skill ID** — kopieren.

Zurück in AWS Console → Lambda → deine Funktion → Configuration →
Triggers, den Alexa-Skills-Kit-Trigger **bearbeiten**:

1. **Skill ID verification** von Disable auf **Enable**.
2. Skill ID einfügen.
3. Speichern.

Damit kann niemand, der zufällig deinen Lambda-ARN kennt, die Funktion
aufrufen.

### Schritt 12 — Test aktivieren und ausprobieren

1. Im Skill Builder oben Tab **Build** → **Build Model**, falls noch
   nicht. Grünen Haken abwarten.
2. Tab **Test**. Den Schalter oben von **"Off"** auf **"Development"**
   stellen. **Pflicht — sonst sieht dein Echo den Skill nicht.**
3. Im Test-Simulator links eintippen:
   `öffne meine hörbücher`.
4. Du solltest die Begrüßung hören/sehen.
5. `mache weiter` versuchen — Lambda liefert eine
   `AudioPlayer.Play`-Direktive im JSON-Output.

> **Der Simulator kann keinen Ton.** Wenn Lambda eine
> `AudioPlayer.Play`-Direktive liefert, zeigt der Test-Simulator
> *"Bei der Antwort des angeforderten Skill ist ein Problem
> aufgetreten"*. Das ist die Limitierung des Simulators, **kein
> echter Fehler**. Im JSON-Output prüfen — wenn dort eine
> wohlgeformte `AudioPlayer.Play`-Direktive mit Stream-URL steht,
> funktioniert der Skill und ein echter Echo spielt das Audio.

Für echte Wiedergabe: mit einem **echten Echo am gleichen Amazon-
Konto** wie deine Developer Console sprechen:

```
"Alexa, öffne meine hörbücher"
"mache weiter"
"Alexa, sage meine hörbücher spiele <buchtitel>"
```

Skills im Development-Modus sind auf eigenen Echos automatisch aktiv —
keine Veröffentlichung, keine "Installation" in der Alexa-App nötig.

> **Erster Aufruf ist langsam.** Cold Start einer ungenutzten Lambda
> plus Round-Trip zu audiobookshelf dauert beim ersten Mal nach
> langer Pause 4–6 Sekunden. Folgeaufrufe sind meist unter 1 Sekunde.
> Wenn der allererste Versuch in einen Timeout läuft (Alexa: "Es
> liegt ein Problem vor"), 10 Sekunden warten und nochmal — dann ist
> die Lambda warm.

### Mehrbenutzer-Setup (optional)

Standardmäßig verwendet der Skill den einen `ABS_API_KEY` für jedes
Echo — passt für einen Single-Haushalt. Wenn mehrere Personen einen
Echo-Haushalt teilen und jede einen eigenen audiobookshelf-Benutzer
haben soll (damit Fortschritt, "weiterhören" und die Liste laufender
Bücher getrennt bleiben), kannst du jedem Echo einen eigenen
audiobookshelf-API-Key zuweisen.

**So funktioniert's.** Jeder Alexa-Request enthält in
`context.System.device.deviceId` eine stabile Geräte-ID. Der Skill
schlägt diese ID in der optionalen Env-Variable `ABS_USERS` (JSON)
nach: bei Treffer wird der Key dieses Benutzers verwendet, bei
Fehlschlag fällt er auf `ABS_API_KEY` (Haushalts-Standard) zurück.
Greift keines, sagt der Skill ansage, dass das Gerät noch nicht
zugeordnet ist.

**Einrichtung.**

1. In audiobookshelf einen API-Key pro Person erstellen (Web-UI →
   Settings → Users → API Keys, jeweils im Account des Benutzers).
2. Die `deviceId` jedes Echos herausfinden:
   - Lambda-Logs in CloudWatch (Lambda → Monitor → Logs anzeigen)
     öffnen und am Zielgerät "Alexa, öffne meine hörbücher" sagen.
     Bei nicht gemappten Geräten erscheint die Zeile
     `Audiobookshelf client init failed: ... deviceId: amzn1.ask.device.XXX`.
   - Alternativ kurz `console.log('deviceId:', deviceIdOf(h))` in
     einen Handler bauen und neu deployen, oder im Test-Simulator im
     JSON-Input-Panel nachschauen.
3. Env-Variable `ABS_USERS` an der Lambda setzen — JSON-Objekt, das
   `deviceId` auf API-Key abbildet:
   ```json
   {
     "amzn1.ask.device.AAA...kueche":  "eyJhbGc...key-alice",
     "amzn1.ask.device.BBB...schlafzimmer": "eyJhbGc...key-bob"
   }
   ```
   (einzeilig — als ein einziger String in das Lambda-Env-Feld
   einfügen, ohne echte Zeilenumbrüche)
4. Optional `ABS_API_KEY` als Haushalts-Standard gesetzt lassen, damit
   noch nicht gemappte Echos trotzdem funktionieren. Weglassen, wenn
   nicht gemappte Geräte lieber keine Wiedergabe starten sollen.
5. **Save** und an jedem Echo testen: "Alexa, öffne meine hörbücher"
   → "welche bücher höre ich gerade?" sollte jetzt die Liste des
   diesem Echo zugewiesenen Benutzers zurückgeben.

**Einschränkungen.**

- Die Zuordnung gilt pro *Gerät*, nicht pro *Person*. Wer mit dem
  Küchen-Echo spricht, bekommt den dort gemappten Benutzer. Alexa
  Voice Profiles (Sprecher-Erkennung) werden nicht ausgewertet.
- Die Alexa-Handy-App und manche Echo-Show-„Überall"-Oberflächen
  haben weniger stabile Geräte-IDs. Für die einen sinnvollen
  `ABS_API_KEY`-Standard setzen.
- Echte Pro-Person-Trennung (ein Amazon-Konto → ein
  audiobookshelf-Benutzer, unabhängig vom Echo) bräuchte Alexa
  Account-Linking via OAuth, das audiobookshelf nicht nativ spricht.

### Fehlersuche

| Symptom | Wahrscheinliche Ursache / Fix |
|---|---|
| **Echo: "Bei der Antwort des angeforderten Skill ist ein Problem aufgetreten"** — der Skill öffnet sauber, scheitert nur an `mache weiter` / `spiele …` | Die **AudioPlayer-Schnittstelle ist nicht aktiviert**. Skill Builder → **Interfaces** → **Audio Player** ON → **Save** → **Build skill**. (Siehe Schritt 10b.) |
| **Echo: "Ich weiß nicht, wie ich dir dabei helfen kann"** bei "Alexa, öffne …" | Entweder (a) der **Test-Schalter** im Developer-Konsole steht auf **"Off"** (auf **Development** stellen), oder (b) der **Aufrufname** wird nicht sauber transkribiert. Im Alexa-**Sprachverlauf** (alexa.amazon.de → Aktivität → Sprachverlauf) ansehen, was Alexa verstanden hat, und einen mehrwortigen Aufrufnamen wählen, der zur Transkription passt. |
| **Echo: "I could not reach your audiobookshelf server"** | API-Key falsch, abgelaufen oder deaktiviert. In audiobookshelf neu erstellen und `ABS_API_KEY` im Lambda-Env aktualisieren. |
| **Echo: "Dieses Echo-Gerät ist noch keinem Audiobookshelf-Benutzer zugeordnet"** | Mehrbenutzer-Modus aktiv (`ABS_USERS` gesetzt), aber die `deviceId` dieses Echos steht nicht in der Map und es gibt keinen `ABS_API_KEY`-Fallback. `deviceId` aus CloudWatch ablesen (`Audiobookshelf client init failed: ... deviceId: amzn1.ask.device.XXX`) und in `ABS_USERS` ergänzen, oder einen `ABS_API_KEY`-Haushalts-Standard setzen. |
| **Erste Wiedergabe-Anfrage läuft in Timeout, zweite klappt** | Lambda Cold Start plus langsamer Upstream; mit kurzem `öffne meine hörbücher` vorwärmen, dann `mache weiter`. Durch das 10-s-Timeout aus Schritt 8 schon abgemildert. |
| **Skill antwortet auf Englisch, obwohl du Deutsch gesprochen hast** | Skill-Builder-Sprache ist en-US. de-DE-Locale im Skill Builder ergänzen oder Primärsprache umstellen. Echo-Sprache muss ebenfalls Deutsch (Deutschland) unter **Alexa-App → Geräte → \<Echo\> → Sprache** sein. |
| **Skill ist gar nicht auf deinem Echo** | Echo und Developer Console müssen am **selben Amazon-Konto** hängen. Unter **Alexa-App → Mehr → Fertigkeiten und Spiele → Deine Fertigkeiten → Dev** nachsehen — der Skill sollte dort erscheinen. Sonst hast du verschiedene Konten benutzt. |
| **`Lambda timeout` in den CloudWatch-Logs** | Default-Timeout 3 Sekunden; auf 10 s erhöhen (Configuration → General configuration → Edit). |
| **`index.handler is undefined`** | ZIP wurde aus dem falschen Verzeichnis gebaut. `zip` **innerhalb von `lambda/`** ausführen, nicht aus dem Repo-Root — `index.js` muss im **Wurzelverzeichnis** der ZIP liegen. |
| **Audio spielt ein paar Sekunden, dann Stopp** | Entweder Cloudflare/Reverse Proxy unterstützt keine HTTP-**Range-Requests**, oder die Datei ist kein für Alexa streambares Format (muss MP3/AAC/M4A/OGG mit passendem `Content-Type` sein). Mit `curl -I -H "Range: bytes=0-1023" "<stream-url>"` testen — du solltest `206 Partial Content` bekommen. |
| **Falsches Buch wird gespielt, oder `spiele <titel>` sagt "konnte nicht finden"** | Im [Sprachverlauf](https://www.amazon.de/alexaprivacy/apd/rvh) nachsehen, was Alexa wirklich verstanden hat — Alexas deutsche Spracherkennung (a) lässt Umlaute weg, (b) verschmilzt Bindestrichworte (`kanguruchroniken` für `Känguru-Chroniken`), (c) verenglisch Endungen (`kangaroochronicles`). Der Fuzzy-Fallback fängt alle drei; falls es trotzdem danebenliegt, das markanteste Wort allein nennen (`spiele Chroniken`). Bei sehr generischem Titel die audiobookshelf-Metadaten oder den Dateinamen anpassen. |
| **`Alexa, nächstes Kapitel` geht nicht, aber `Alexa, weiter` schon** | Erwartet. Während AudioPlayer läuft, erreichen den Skill nur Built-in-Intents (NextIntent, PauseIntent, …). Die kurzen `weiter` / `zurück` benutzen — sie mappen auf denselben Kapitel-Skip-Handler. |

CloudWatch ist dein Freund. Auf der Lambda-Seite → **Monitor** →
**Logs anzeigen in CloudWatch** das jüngste Log-Stream öffnen, um
`console.error` und `console.log` aus dem Handler zu sehen. Die
`AudioPlayer event:`-Zeilen zeigen, welche AudioPlayer-Events Echo
zurückgesendet hat und ggf. den Fehlercode.

### Neu deployen nach Code-Änderungen

Nach Änderungen in `lambda/` (Bash / WSL / Git Bash):

```bash
cd lambda
npm install        # nur falls package.json geändert
npm test           # immer, vor dem Deployen
zip -r ../audiobookshelf-alexa.zip . -x "test/*"
cd ..
```

PowerShell-Äquivalent (Windows):

```powershell
Push-Location lambda
npm install        # nur falls package.json geändert
npm test           # immer, vor dem Deployen
Pop-Location
$temp = Join-Path $env:TEMP "abs-alexa-pkg"
if (Test-Path "audiobookshelf-alexa.zip") { Remove-Item "audiobookshelf-alexa.zip" -Force }
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
New-Item -ItemType Directory -Path $temp | Out-Null
Get-ChildItem -Path "lambda" -Exclude "test" | Copy-Item -Destination $temp -Recurse -Force
Compress-Archive -Path (Join-Path $temp "*") -DestinationPath "audiobookshelf-alexa.zip" -Force
Remove-Item $temp -Recurse -Force
```

Neue ZIP über Lambda → Code → **Hochladen von** → **.zip-Datei**
einspielen. Das Alexa-Skill-Modell muss nur neu hochgeladen werden,
wenn du `skill-package/` geändert hast. Nach Modelländerung im Skill
Builder **Build Model** klicken — und nach Änderungen an
**Interfaces** oder Aufrufnamen ebenfalls neu bauen.

Wenn du das AudioPlayer-Token-Format (`lib/playback.js`) änderst,
schlagen laufende Wiedergabesessions bis zum Neustart fehl — alte
Tokens dekodieren nicht gegen den neuen Code.

## Power-User-Abkürzung: ASK CLI

Wer auf der Kommandozeile zuhause ist, fasst die Schritte 6–11 mit
der [ASK CLI](https://developer.amazon.com/en-US/docs/alexa/smapi/quick-start-alexa-skills-kit-command-line-interface.html)
in einem Befehl zusammen:

```bash
npm i -g ask-cli
ask configure       # einmalig browser-basierter AWS- + Alexa-Login
cd lambda && npm install && cd ..
ask deploy
```

`ask deploy` packt `lambda/`, legt die Lambda-Funktion an oder
aktualisiert sie, lädt das Skill-Manifest und die Interaction Models
hoch und verdrahtet den Endpoint. `ABS_BASE_URL` und `ABS_API_KEY`
einmalig auf der Lambda setzen (Lambda-Konsole → Configuration →
Environment variables, oder `aws lambda update-function-configuration`).

## Entwicklung

```bash
cd lambda
npm install
npm test            # 45 Tests über Helfer, HTTP-Client und Handler
node --check index.js
```

### Debuggen ohne Echo

`test/handler.test.js` ruft `exports.handler` direkt mit
synthetisierten Alexa-Request-Envelopes (Launch, IntentRequest,
AudioPlayer-Events, PlaybackController) auf. Die audiobookshelf-API
ist über einen In-Memory-Mock (`test/fixtures/abs-mock.js`) gestubbt,
der ganze Suite läuft offline.

Das ist der einzige Weg, den **AudioPlayer-Event-Flow** zu testen —
Developer-Console-Simulator und `ask dialog` feuern keine
`AudioPlayer.PlaybackStarted` / `PlaybackNearlyFinished` /
`PlaybackStopped`, sodass Auto-Enqueue und Sleep-Timer-Logik dort
nicht prüfbar sind. Die Handler-Tests decken diese Events
end-to-end ab:

```bash
npm test
```

Iterationsschleife: `index.js` editieren → `npm test` → fertig.

Für ad-hoc Live-Tests gegen eine echte audiobookshelf-Instanz
`ABS_BASE_URL` und `ABS_API_KEY` setzen und `lib/absClient.js` direkt
aufrufen:

```js
const { fromEnv } = require('./lib/absClient');
const c = fromEnv();
c.listLibraries().then((r) => console.log(JSON.stringify(r, null, 2)));
```

## Sprachbefehl-Spickzettel

Alexa behandelt Befehle unterschiedlich, je nachdem, ob dein Skill in
einer **aktiven Session** ist (du hast gerade "öffne meine hörbücher"
gesagt und Alexa wartet auf Folgebefehle) oder im **AudioPlayer-Modus**
(ein Buch läuft). Im AudioPlayer-Modus erreichen den Skill nur
Built-in-Intents ohne explizite Anrufung — eigene Phrasen brauchen den
Skill-Namen.

| Was du willst | Aktive Session | AudioPlayer-Modus (Buch läuft) |
|---|---|---|
| Buch starten | `spiele <titel>` | `Alexa, sage meine hörbücher spiele <titel>` |
| Letztes Buch fortsetzen | `mache weiter` | nicht nötig (läuft schon) |
| Pause | `pause` | `Alexa, pause` |
| Stop | `stop` | `Alexa, stop` |
| Nächstes Kapitel | `nächstes kapitel` / `weiter` | **`Alexa, weiter`** oder `Alexa, nächstes` (Built-in) |
| Voriges Kapitel | `voriges kapitel` / `zurück` | **`Alexa, zurück`** (Built-in) |
| ±N Sekunden/Minuten springen | `spring 30 sekunden vor` | `Alexa, sage meine hörbücher spring 30 sekunden vor` |
| Sleep Timer | `stelle den sleep timer auf 20 minuten` | `Alexa, sage meine hörbücher sleep timer 20 minuten` |
| Was läuft gerade | `welche bücher höre ich gerade` | Alexa-App nutzen oder vorher pausieren |

> **Warum "nächstes Kapitel" während der Wiedergabe nicht ohne
> weiteres geht.** Alexa Skills Kit leitet im AudioPlayer-Modus nur
> eine feste Liste Built-in-Intents (`AMAZON.NextIntent`,
> `AMAZON.PreviousIntent`, `AMAZON.PauseIntent`, `AMAZON.StopIntent`,
> `AMAZON.ResumeIntent`, …) an den Skill weiter. Eigene Intents wie
> `NextChapterIntent` matchen nur bei expliziter Anrufung. Die gute
> Nachricht: `Alexa, weiter` macht den Kapitelsprung schon, weil der
> Skill `AMAZON.NextIntent` auf denselben Handler wie
> `NextChapterIntent` mappt.

## Einschränkungen / bekannte Lücken

- **Nur für Privatgebrauch.** Kein Alexa-Account-Linking (OAuth).
  Der Skill kann pro *Gerät* einen audiobookshelf-Benutzer wählen
  (`ABS_USERS`, siehe *Mehrbenutzer-Setup*) oder fällt auf einen
  einzigen `ABS_API_KEY` zurück, kann aber Sprecher am selben Echo
  nicht unterscheiden. Diesen Skill nicht unverändert im öffentlichen
  Alexa-Store veröffentlichen.
- **Suche ist Best-Effort.** Der Skill probiert zuerst die
  serverseitige audiobookshelf-Suche mit mehreren Query-Varianten
  (roh, ohne Bindestriche, ohne Artikel, längstes Schlagwort) und
  fällt auf einen lokalen Fuzzy-Match zurück (3-Gramm-Score mit
  Substring-Bonus, Umlaut-/Interpunktion-Normalisierung) über die
  ganze Bibliothek. Das fängt Alexas Eigenheit, Wörter zu verschmelzen
  (`kanguruchroniken` → `Känguru-Chroniken`) und Endungen zu
  verenglischen (`kangaroochronicles`). Bei hunderten Büchern mit
  sehr ähnlichen Titeln kann der Top-Treffer trotzdem falsch sein —
  dann das markanteste Wort des Titels nennen
  (`spiele Känguru-Chroniken`).
- **Sleep-Timer-Überlauf** — die Deadline greift an
  AudioPlayer-Event-Grenzen. Die Wiedergabe endet am Ende des Tracks,
  der nach der Deadline fast fertig ist. Bei 30-Minuten-Dateien kann
  der Timer bis zu eine Datei überlaufen; bei wenigen Minuten
  (typisch ein Kapitel pro Datei) ist der Überlauf gering.
- **Fortschritts-Sync** sendet einen Heartbeat bei AudioPlayer-Events;
  sub-Sekunden-Genauigkeit gegenüber dem audiobookshelf-Web-Player ist
  nicht garantiert.
- **`Mache weiter` nimmt das neueste laufende Buch**, wenn kein Titel
  genannt ist. Bei vielen offenen Büchern lieber
  `Mache mit <Titel> weiter` für Vorhersagbarkeit.

## audiobookshelf-API-Referenzen

- API-Referenz (laut Eigenangabe veraltet, aber bester Startpunkt):
  <https://api.audiobookshelf.org/>
- API-Keys-Guide: <https://www.audiobookshelf.org/guides/api-keys/>
- Aktuelle API-Quelle der Wahrheit: der audiobookshelf-Server-Quellcode
  selbst unter <https://github.com/advplyr/audiobookshelf>.
