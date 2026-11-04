# Phone Pad

Turns an iPhone into a PS5-style or Xbox-style controller for a Windows laptop. Tap the status on
the controller to switch between them. Either way, games see a normal Xbox 360 pad, the most widely
supported kind, and their rumble comes back as haptics on the phone.

## Set up once

1. On the iPhone, install **Expo Go** from the App Store.
2. Make sure **Settings > Sounds & Haptics > System Haptics** is on and Low Power Mode is off.
   iOS silences app haptics otherwise.
3. For the USB cable, install **Apple Devices** from the Microsoft Store and tap **Trust** on the
   phone when you plug it in.

The first time you open **Phone Pad.cmd**, it installs the gamepad driver and a firewall rule. Click
Yes when Windows asks for permission.

## Play

1. Double-click **Phone Pad.cmd**. One window opens, with the pairing code in its title bar. Closing
   it stops everything.
2. On the phone, open Expo Go and tap Phone Pad under Recently Opened.

The first time on each phone, scan the QR code with the camera instead, allow Local Network access,
and enter the pairing code. The phone remembers it.

The app connects over the best link it can find. Tap the status at the top to see it or change the
code. It picks a link when connecting, so if you plug in the cable mid-session, open the status
and tap Connect.

| Link | How | Speed |
| --- | --- | --- |
| USB cable | Plug in, turn on Personal Hotspot | Fastest |
| Wi-Fi | Same network as the laptop | Good, can spike on a busy network |
| Bluetooth | Pair, turn on Personal Hotspot, then on the laptop open Bluetooth devices > Join a Personal Area Network and connect to the phone | Slowest |

USB and Bluetooth both run over Personal Hotspot, because iOS doesn't allow an app to act as a
Bluetooth gamepad. Control traffic stays between the phone and laptop and uses no cellular data,
but anything else the laptop does online while tethered will.

## More than one phone

Up to 4 phones can play at once, each as its own controller. On each extra phone, install Expo Go,
scan the same QR code and enter the same pairing code. The status on each phone shows its player
number, such as `P2`.

- Each phone gets its own rumble, and one leaving doesn't affect the others.
- A phone that drops comes back as the same player. Its slot is only given away if four other phones
  need the slots.
- Controllers stay plugged in until the server closes, so a player who left shows up to games as an
  idle controller. Restart the server to clear them.

## Friends, from a browser

Friends don't need to install anything, and your phone can stay on Expo Go. Both kinds of phone can
play at once and share the 4 player slots.

1. Double-click **Phone Pad.cmd**. A QR code for friends opens in a browser window on the laptop. If
   you close it, **Invite Friends.cmd** brings it back.
2. Friends join the laptop's Wi-Fi network and scan that code with their camera. The QR code in the
   Phone Pad window is the Expo Go one.

The browser version is for casual play. Expo Go is better for you:

| | Expo Go | Browser |
| --- | --- | --- |
| Haptics | Full, including game rumble | A light tick on presses at most. Game rumble doesn't reach the phone reliably |
| Links | USB, Wi-Fi, Bluetooth | Wi-Fi |
| Screen | Full screen, stays awake | Full screen on Android. On iPhone, Safari's toolbars take some room unless added to the Home Screen. The screen can sleep if left untouched |

**Full screen:** on Android and computers, the browser goes full screen at the first touch on the
controller, and the status page has a button to leave or re-enter it. iPhone Safari doesn't allow
full screen for web pages, so on an iPhone tap Share, then Add to Home Screen, and open it from
there. That copy keeps its own saved button positions, so it asks for the thumb test again.

The link includes the pairing code, so anyone who has it can join while they're on your network. To
change the code, delete `server\.pin` and reopen Phone Pad. Everyone then needs a new link, and each
Expo Go phone needs the new code.

## Controls

- **Button positions** are fitted the first time a phone connects, once per controller style. Hold
  the phone as you play, rest both thumbs on the screen, sweep them as far as is comfortable, then
  lift. The sticks, D-pad and face buttons move to fit, then tap Done. The phone or browser remembers
  them. To change them later, tap the status, then **Redo thumb test** or **Adjust manually** to drag
  any control, including the triggers and menu buttons, yourself.
- **Sticks** re-centre where your thumb lands. Double-tap and hold for L3/R3.
- **Triggers** are analog: slide down to pull harder. The lower part is a full pull.
- **Face buttons** overlap at the edges, so a thumb between two buttons presses both.
- **PS5 style** has the D-pad high and the left stick low. **Xbox style** swaps them. Both have the face
  buttons in a diamond.
- **The touchpad** (PS5 style) presses like a button and does the same as Create. It doesn't track swipes.
- **The light bars** (PS5 style) are blue when connected and amber when searching.

Games show Xbox prompts in both styles. In PS5 style, read them by position:

| On the phone | In-game prompt |
| --- | --- |
| Cross, Circle, Square, Triangle | A, B, X, Y |
| L1, R1, L2, R2 | LB, RB, LT, RT |
| Create or touchpad, Options, PS | View/Back, Menu/Start, Guide |

## Tests

```
cd app; npm test
cd app; npm run test:e2e   # button calibration in headless Chrome or Edge
cd server; .venv\Scripts\python -m unittest test_server
```
