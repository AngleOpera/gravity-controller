# @rbxts/gravity-controller

TypeScript bindings for [EgoMoose's Rbx-Gravity-Controller](https://github.com/EgoMoose/Rbx-Gravity-Controller) with
ground-normal-based wall walking by [EmilyBendsSpace](https://x.com/EmilyBendsSpace).

Players can walk on walls, ceilings, and any arbitrary surface with smooth gravity transitions.

## Installation

```bash
npm install @rbxts/gravity-controller
```

The package ships a `GravityController/` directory tree containing the Luau runtime (camera, collider, state tracker, animations, and character sounds). Rojo syncs this tree into the data model the same way it would a single `.rbxmx`. The TypeScript wrapper in `src/index.ts` handles deploying those scripts at runtime and provides typed access to the controller.

## How it works

### Architecture

```
Server (onInit)                         Client (onStart)
─────────────────                       ──────────────────
installGravityControllerClass()         installGravityControllerClass()
  ├─ Copies Client/PlayerScriptsLoader    └─ require("GravityController")
  │  → StarterPlayerScripts                     from ReplicatedStorage
  ├─ Copies Client/RbxCharacterSounds           ↓
  │  → StarterPlayerScripts             new GravityControllerClass(player)
  ├─ Copies Client/Animate                ├─ Camera  (custom camera module)
  │  → StarterCharacterScripts            ├─ Control (input → move vector)
  └─ Moves GravityController module       ├─ Collider (physics body movers)
     → ReplicatedStorage                  └─ StateTracker (humanoid states)
```

`installGravityControllerClass()` must be called on **both** the server and the client. On the server it deploys the bundled scripts into `StarterPlayerScripts`, `StarterCharacterScripts`, and `ReplicatedStorage`. On the client it `require`s the `GravityController` ModuleScript from `ReplicatedStorage` and returns the class.

### Permanent runtime modifications

The server-side `installGravityControllerClass()` **replaces** scripts in StarterPlayerScripts / StarterCharacterScripts:

- **PlayerScriptsLoader** — modified version that monkey-patches `BaseCamera`, `CameraUtils`, `Poppercam`, and the `CameraModule.Update` loop to support arbitrary gravity up-vectors
- **Animate** — custom version that works with `PlatformStand = true`
- **RbxCharacterSounds** — custom version driven by the gravity controller's `StateTracker` rather than native `Humanoid` state

These replacements are **permanent for the session** — they survive `GravityController:Destroy()`.

### Key monkey-patch: `BaseCamera:UpdateMouseBehavior()`

The modified PlayerScriptsLoader overrides `BaseCamera:UpdateMouseBehavior()` to force `UserGameSettings.RotationType` from `CameraRelative` to `MovementRelative`. This is necessary while the gravity controller is active because `CameraRelative` rotation conflicts with the custom `BodyGyro`-driven character orientation.

This override is guarded by `_G._gravityControllerActive` so it only applies while a gravity controller instance is alive. Without this guard, any first-person camera system that depends on `CameraRelative` (such as Character-Realism's `FpsCamera`) will break permanently after gravity controller destruction.

### What a GravityController instance does (per-player, temporary)

- Sets `Humanoid.PlatformStand = true` (disables the default humanoid physics)
- Creates collision proxy parts (Sphere, FloorDetector, JumpDetector) welded to HRP
- Adds `VectorForce`, `BodyGyro`, `BodyPosition` to HRP
- Binds `"GravityStep"` RenderStep at priority `Camera - 1` (199)
- Sets `_G._gravityControllerActive = true`

### What `GravityController:Destroy()` does

- Unbinds `"GravityStep"` from RenderStep
- `Maid:Sweep()` — destroys all proxy parts, body movers, disconnects events
- Sets `Humanoid.PlatformStand = false`
- Sets `_G._gravityControllerActive = false`

It does **not** restore the Animate script or the PlayerScriptsLoader — those persist.

### Gravity step (per frame)

Each render frame the controller runs `onGravityStep`:

1. **Query gravity direction** — calls `GetGravityUp(oldGravity)` which you can override. By default it returns the previous gravity (no change). Assign `getGravityControllerUp` to enable surface-following wall walk.
2. **Lerp transition** — spherically interpolates from the old gravity direction toward the new one, controlled by `Transition` (default `0.15`).
3. **Compute world move vector** — projects the camera-relative input onto the plane perpendicular to gravity so the character always moves along the surface.
4. **Compute forces** — calculates a counter-gravity force (`gForce`) and a walk force (`walkForce`) that accelerates the character toward target velocity.
5. **Optional horizontal lock** — when `UseBodyPositionLock` is enabled and the character is standing still on an aligned surface, a `BodyPosition` prevents micro-sliding.
6. **Update collider and state** — applies the combined force to the character's body movers and updates the state tracker (running, jumping, freefall, etc.).

### Interaction with first-person camera systems

If you use a first-person camera module (e.g. Character-Realism's `FpsCamera`) that depends on `UserGameSettings.RotationType` being `CameraRelative`:

- While the gravity controller is **active**, `onGravityStep` handles character rotation via `BodyGyro`. The `_G._gravityControllerActive` flag ensures the monkey-patch forces `MovementRelative` only during this time.
- After `Destroy()`, the flag clears and the monkey-patch becomes a no-op, allowing your first-person system to set `AutoRotate = false` and take over character rotation normally.

### Ground normal detection (`getGroundNormal`)

The exported `getGroundNormal` function determines which direction is "up" by casting rays from the character's root part:

| Ray group | Count | Purpose |
|---|---|---|
| Center ray | 1 | Single downward ray (length 25) to find the surface directly below |
| Down rays | 24 | Radial ring of rays angled slightly inward/outward, with alternating even/odd radii, to sample the surrounding surface normals |
| Feeler rays | 9 | Shorter rays (length 2) fanning outward and downward to detect walls and edges the character is approaching |

All hit normals are weighted (front-facing rays weighted more heavily, feelers weighted 8x) and summed. The final unit vector becomes the new "up" direction. If no rays hit anything, the previous gravity direction is preserved.

### `GravityController/` file tree

The `GravityController/` directory contains all the Luau source files and a few `.rbxmx` files for non-script instances. Rojo syncs this tree into the data model as the same instance hierarchy that was previously shipped as a single `.rbxmx`. During `installGravityControllerClass()` the children are deployed to the correct locations in the Roblox data model.

```
GravityController/
├── init.server.luau              ← Script; server entry point, deploys children at runtime
├── Client/                       ← Folder; scripts that get copied into StarterPlayer
│   ├── init.meta.json
│   ├── Animate/                  ← LocalScript → StarterCharacterScripts
│   │   ├── init.client.luau
│   │   ├── Controller.luau       — bootstraps R6/R15 animation sets
│   │   ├── Loaded.rbxmx          — BoolValue; signals when animations are ready
│   │   ├── PlayEmote.rbxmx       — BindableFunction; emote playback hook
│   │   ├── R15.luau              — full R15 animation state machine
│   │   ├── R6.luau               — full R6 animation state machine
│   │   ├── ReplicatedHumanoid.rbxmx — ObjectValue; humanoid reference for replication
│   │   └── VerifyAnims.luau      — validates animation assets on the character
│   ├── PlayerScriptsLoader/      ← LocalScript → StarterPlayerScripts
│   │   ├── init.client.luau
│   │   ├── CameraInjector.luau   — monkey-patches PlayerModule's CameraModule
│   │   │                           to expose a public GetUpVector API for gravity-aware
│   │   │                           camera rotation
│   │   └── FakeUserSettings.luau — shims UserSettings() to override feature flags
│   │                               (e.g. disables UserRemoveTheCameraApi) during
│   │                               camera injection
│   └── RbxCharacterSounds/       ← LocalScript → StarterPlayerScripts
│       ├── init.client.luau
│       └── AnimationState.luau   — maps animation track names to HumanoidStateTypes
│                                   so footstep/jump/fall sounds play correctly under
│                                   custom gravity
└── GravityController/            ← ModuleScript → ReplicatedStorage
    ├── init.luau
    ├── CharacterModules/         ← Folder
    │   ├── init.meta.json
    │   ├── Camera.luau           — hooks into PlayerModule cameras to override
    │   │                           GetUpVector, making the camera orbit around the
    │   │                           custom gravity axis
    │   └── Control.luau          — wraps PlayerModule controls to read the move
    │                               vector from keyboard/gamepad/touch input
    ├── Collider.luau             — creates an invisible Ball Part welded below
    │                               the HRP for ground detection, plus VectorForce
    │                               (gravity + walk), BodyGyro (orientation), and
    │                               BodyPosition (optional anti-slide lock)
    ├── StateTracker.luau         — replaces Humanoid state detection with velocity-based
    │                               Running/Jumping/Freefall tracking and fires the
    │                               Animate script's callbacks (onRunning, onJumping,
    │                               onFreeFall, etc.)
    └── Utility/                  ← Folder
        ├── init.meta.json
        ├── Maid.luau             — connection/instance cleanup utility
        └── Signal.luau           — lightweight event/signal implementation
```

**Where each piece ends up at runtime:**

| Script | Deployed to | Role |
|---|---|---|
| `Client/PlayerScriptsLoader` | `StarterPlayerScripts` | Replaces the default PlayerScriptsLoader to inject gravity-aware camera and control overrides into the stock `PlayerModule` |
| `Client/RbxCharacterSounds` | `StarterPlayerScripts` | Replaces default character sounds so audio triggers are driven by the custom `StateTracker` instead of the native `Humanoid` state |
| `Client/Animate` | `StarterCharacterScripts` | Replaces default Animate script; plays R6/R15 animations driven by `StateTracker.Changed` events rather than native humanoid states |
| `GravityController` | `ReplicatedStorage` | The core module — `require`d by both the TypeScript wrapper and the PlayerScriptsLoader at runtime |

## API

### `installGravityControllerClass(config?)`

Initializes the gravity system. Call on both server and client. Returns the `GravityControllerClass` constructor. Idempotent — calling it again returns the same class (and optionally applies new config).

### `GravityControllerClass`

| Member | Type | Description |
|---|---|---|
| `new(player)` | constructor | Creates a controller for the given player's current character |
| `SetConstants(config)` | static method | Updates physics constants globally (see Configuration below) |

### `GravityController` (instance)

| Member | Type | Description |
|---|---|---|
| `Player` | `Player` | The owning player |
| `Character` | `Model` | The player's character model |
| `Humanoid` | `Humanoid` | The character's humanoid |
| `HRP` | `BasePart` | `HumanoidRootPart` |
| `Maid` | `{ Mark }` | Cleanup helper — tracks connections for automatic teardown |
| `GetGravityUp(oldGravity)` | method | Override this to control gravity direction each frame. Default returns `oldGravity` (no change). |
| `ResetGravity(direction)` | method | Instantly sets the gravity-up vector and resets the fall tracker |
| `GetFallHeight()` | method | Returns the signed distance fallen along the gravity axis while in freefall; `0` otherwise |
| `Destroy()` | method | Unbinds the render step, sweeps all connections, and restores `PlatformStand` |

### `GravityManager`

A plain TypeScript class (no framework dependencies) that manages the full lifecycle of a `GravityController` instance — waiting for the character and Animate script, constructing the controller, handling timeouts and retries, and tearing down cleanly.

```typescript
const cls = installGravityControllerClass(config)
const manager = new GravityManager(cls, logger)

manager.enable(getGravityControllerUp)  // async 4-phase construction
manager.disable()                       // teardown + reset GravityUp attribute
manager.getController()                 // live instance or undefined
manager.getIsEnabling()                 // true while construction is in-flight
```

**Constructor:** `new GravityManager(gravityControllerClass, logger?)`

- `gravityControllerClass` — the class returned by `installGravityControllerClass()`
- `logger` — optional `GravityLogger` (see below). If omitted, logging is silently skipped.

**`enable(getGravityUp)`** — starts a 4-phase async construction:

1. Waits for `Players.LocalPlayer.Character` to exist
2. Waits for the `Animate` script and its `Controller` child (with timeout)
3. Waits for the `Animate` module to finish loading (`Loaded.Value = true`)
4. Constructs the `GravityController` instance and assigns `GetGravityUp`

Each call stores the requested `getGravityUp` function. If `enable()` is called again while construction is in-flight, the new function is saved and will be used when the current construction completes or on retry.

A generation counter invalidates stale constructions — if `disable()` is called while construction is running, the in-flight thread is cancelled and any completed-but-stale controller is destroyed immediately.

A watchdog fires after the timeout period and hard-cancels stuck construction threads, cleans up partial state (`GravityStep` RenderStep binding, `PlatformStand`), and triggers a retry.

**`disable()`** — tears down the active controller:

- Increments the generation counter (invalidating any in-flight construction)
- Cancels the construction thread if running
- Calls `Destroy()` on the live controller
- Sets the HRP `GravityUp` attribute to `(0, 1, 0)`

**`getController()`** — returns the live `GravityController` instance or `undefined`.

**`getIsEnabling()`** — returns `true` while construction is in-flight.

### `GravityLogger`

Minimal logging interface so the package doesn't depend on any specific logging library. Any object with `Info`, `Warn`, and `Error` string methods satisfies it — including `@rbxts/log`'s `Logger`.

```typescript
interface GravityLogger {
  Info(message: string): void
  Warn(message: string): void
  Error(message: string): void
}
```

### `wrapGravityUpSaveAttribute(getGravityUp)`

Higher-order function that wraps a `GetGravityUp` function to persist the current gravity direction as an HRP attribute (`GravityUp`). Only writes when the direction actually changes (magnitude delta > 0.001).

```typescript
manager.enable(wrapGravityUpSaveAttribute(getGravityControllerUp))
```

### `GetGravityUp` (type)

```typescript
type GetGravityUp = (self: GravityController, oldGravityUp: Vector3) => Vector3
```

The signature for gravity direction functions. Passed to `GravityManager.enable()` or assigned to `controller.GetGravityUp`.

### `getGravityControllerUp(controller, oldGravityUp)`

Convenience wrapper that calls `getGroundNormal` using the controller's `HRP.CFrame` with a rig-type-aware origin offset. Assign this to `controller.GetGravityUp` to enable wall walking.

### `getGroundNormal(cframe, originOffset, oldGravityUp)`

Low-level raycast function that returns a unit `Vector3` representing the surface normal beneath and around `cframe`. Useful if you want to build your own gravity logic.

## Configuration

Pass a config table to `installGravityControllerClass()` or call `SetConstants()` at any time:

| Key | Type | Default | Description |
|---|---|---|---|
| `Transition` | `number` | `0.15` | Lerp alpha per frame for gravity direction changes. Lower = slower, smoother transitions. |
| `WalkForce` | `number` | `66.67` | Horizontal acceleration multiplier. Increase for snappier movement. |
| `JumpModifier` | `number` | `1.2` | Multiplier on `Humanoid.JumpPower` when jumping along the custom gravity axis. |
| `UseBodyPositionLock` | `boolean` | `false` | When `true`, locks the character's horizontal position with a `BodyPosition` while idle on an aligned surface to prevent sliding. |

## Usage

### With GravityManager (recommended)

**Server** — install in a `@Service`:

```typescript
import { OnInit, Service } from '@flamework/core'
import { installGravityControllerClass } from '@rbxts/gravity-controller'

@Service()
export class GravityService implements OnInit {
  onInit() {
    installGravityControllerClass()
  }
}
```

**Client** — use `GravityManager` to handle the full enable/disable lifecycle:

```typescript
import { Controller, OnStart } from '@flamework/core'
import {
  getGravityControllerUp,
  GravityManager,
  installGravityControllerClass,
  wrapGravityUpSaveAttribute,
} from '@rbxts/gravity-controller'
import { Logger } from '@rbxts/log'

@Controller({})
export class PlayerGravityController implements OnStart {
  private gravityManager: GravityManager | undefined

  constructor(private logger: Logger) {}

  onStart() {
    const cls = installGravityControllerClass()
    this.gravityManager = new GravityManager(cls, this.logger)

    // Enable gravity with surface-following wall walk
    this.gravityManager.enable(
      wrapGravityUpSaveAttribute(getGravityControllerUp),
    )
  }

  disable() {
    this.gravityManager?.disable()
  }
}
```

### Manual lifecycle (without GravityManager)

If you need full control over construction timing:

```typescript
import {
  installGravityControllerClass,
  getGravityControllerUp,
} from '@rbxts/gravity-controller'
import { Players } from '@rbxts/services'

const GravityControllerClass = installGravityControllerClass()

Players.LocalPlayer.CharacterAdded.Connect(() => {
  const gc = new GravityControllerClass(Players.LocalPlayer)
  gc.GetGravityUp = getGravityControllerUp
})
```

### Custom gravity direction

If you don't want surface-following wall walk, you can point gravity in any fixed direction:

```typescript
const gc = new GravityControllerClass(Players.LocalPlayer)

// Gravity pulls toward -X (sideways)
gc.GetGravityUp = () => new Vector3(1, 0, 0)
```

Or reset gravity imperatively:

```typescript
gc.ResetGravity(new Vector3(0, -1, 0)) // flip upside down
```

## Credits

- [EgoMoose](https://github.com/EgoMoose) — original [Rbx-Gravity-Controller](https://github.com/EgoMoose/Rbx-Gravity-Controller) Lua implementation
- [EmilyBendsSpace](https://x.com/EmilyBendsSpace) — improved ground normal raycasting for smooth wall walking ([DevForum post](https://devforum.roblox.com/t/example-source-smooth-wall-walking-gravity-controller-from-club-raven/440229))

## License

MIT
