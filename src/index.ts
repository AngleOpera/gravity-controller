import {
  Players,
  ReplicatedStorage,
  RunService,
  StarterPlayer,
  Workspace,
} from '@rbxts/services'

export interface GravityController extends Instance {
  Player: Player
  Character: Model
  Humanoid: Humanoid
  HRP: BasePart
  Maid: {
    Mark: (connection: RBXScriptConnection) => void
  }
  GetFallHeight(): number
  GetGravityUp(self: GravityController, oldGravityUp: Vector3): Vector3
  ResetGravity(gravityDirection: Vector3): void
}

export interface GravityControllerClass {
  new (player: Player): GravityController
  SetConstants(config: {
    Transition?: number
    WalkForce?: number
    JumpModifier?: number
    UseBodyPositionLock?: boolean
  }): void
}

export interface GravityControllerConfig {
  Transition?: number
  WalkForce?: number
  JumpModifier?: number
  UseBodyPositionLock?: boolean
}

export interface GravityLogger {
  Info(message: string): void
  Warn(message: string): void
  Error(message: string): void
}

export type GetGravityUp = (
  self: GravityController,
  oldGravityUp: Vector3,
) => Vector3

export let gravityControllerClass: GravityControllerClass

export function installGravityControllerClass(
  config?: GravityControllerConfig,
) {
  if (gravityControllerClass) {
    if (config) {
      gravityControllerClass.SetConstants(config)
    }
    return gravityControllerClass
  }
  if (RunService.IsServer()) {
    const starterPlayerScripts = StarterPlayer.WaitForChild(
      'StarterPlayerScripts',
    )
    const starterCharacterScripts = StarterPlayer.WaitForChild(
      'StarterCharacterScripts',
    )
    const parent = script.Parent?.WaitForChild('GravityController')
    if (!parent) throw 'GravityController module not found'
    const client = parent.WaitForChild('Client')
    const replace = (child: Instance, parent: Instance) => {
      const found = parent.FindFirstChild(child.Name)
      found?.Destroy()
      child.Parent = parent
    }
    replace(client.WaitForChild('PlayerScriptsLoader'), starterPlayerScripts)
    replace(client.WaitForChild('RbxCharacterSounds'), starterPlayerScripts)
    replace(client.WaitForChild('Animate'), starterCharacterScripts)
    parent.WaitForChild('GravityController').Parent = ReplicatedStorage
  }
  gravityControllerClass = require(
    ReplicatedStorage.WaitForChild('GravityController') as ModuleScript,
  ) as GravityControllerClass

  if (config && gravityControllerClass.SetConstants) {
    gravityControllerClass.SetConstants(config)
  }

  return gravityControllerClass
}

// ── Utility ──────────────────────────────────────────────────────────

export function wrapGravityUpSaveAttribute(getGravityUp: GetGravityUp) {
  return (gravityController: GravityController, oldGravityUp: Vector3) => {
    const up = getGravityUp(gravityController, oldGravityUp)
    if (up.sub(oldGravityUp).Magnitude > 0.001) {
      gravityController.HRP.SetAttribute('GravityUp', up)
    }
    return up
  }
}

// ── GravityManager ───────────────────────────────────────────────────

const ENABLING_STALE_SEC = 5
const MAX_GRAVITY_RETRIES = 3
const RETRY_BACKOFF_SEC = 2

const noopLogger: GravityLogger = {
  Info() {},
  Warn() {},
  Error() {},
}

export class GravityManager {
  private _controller: GravityController | undefined
  private _enabling = false
  private enablingStartedAt = 0
  private generation = 0
  private retryCount = 0
  private constructionThread: thread | undefined
  private pendingGetGravityUp: GetGravityUp | undefined

  private readonly gravityControllerClass: GravityControllerClass
  private readonly logger: GravityLogger

  constructor(
    gravityControllerClass: GravityControllerClass,
    logger?: GravityLogger,
  ) {
    this.gravityControllerClass = gravityControllerClass
    this.logger = logger ?? noopLogger
  }

  getController(): GravityController | undefined {
    return this._controller
  }

  getIsEnabling(): boolean {
    return this._enabling
  }

  disable() {
    const wasActive = this._controller !== undefined
    const wasEnabling = this._enabling
    if (!wasActive && !wasEnabling) return

    const prevGen = this.generation
    this.generation++
    this._enabling = false
    this.pendingGetGravityUp = undefined
    this.retryCount = 0

    if (this.constructionThread) {
      pcall(() => task.cancel(this.constructionThread!))
      this.constructionThread = undefined
    }

    this.logger.Info(
      `Disabling gravity controller: wasActive=${wasActive}, wasEnabling=${wasEnabling}` +
        `, gen=${prevGen}->${this.generation}`,
    )

    this._controller?.Destroy()
    this._controller = undefined

    const hrp = Players.LocalPlayer.Character?.FindFirstChild(
      'HumanoidRootPart',
    ) as BasePart | undefined
    hrp?.SetAttribute('GravityUp', new Vector3(0, 1, 0))
  }

  enable(getGravityUp: GetGravityUp) {
    this.pendingGetGravityUp = getGravityUp
    if (this._controller) return

    const now = Workspace.GetServerTimeNow()
    if (this._enabling && now - this.enablingStartedAt < ENABLING_STALE_SEC)
      return

    this._enabling = true
    this.enablingStartedAt = now
    const generation = this.generation
    const timeout = ENABLING_STALE_SEC + this.retryCount * RETRY_BACKOFF_SEC
    this.logger.Info(
      `Enabling gravity controller (gen ${generation}, timeout ${timeout}s)`,
    )

    this.constructionThread = task.spawn(() => {
      // Phase 1: wait for character
      if (!Players.LocalPlayer.Character) {
        Players.LocalPlayer.CharacterAdded.Wait()
      }
      const character = Players.LocalPlayer.Character
      if (generation !== this.generation) {
        this._enabling = false
        const pending = this.pendingGetGravityUp
        if (pending) this.enable(pending)
        return
      }

      // Phase 2: wait for Animate script + Controller instance
      const animate = character!.WaitForChild('Animate', timeout)
      if (!animate) {
        this.retryEnable(generation, `Animate not found after ${timeout}s`)
        return
      }
      const animController = animate.WaitForChild('Controller', timeout)
      if (!animController) {
        this.retryEnable(
          generation,
          `Animate.Controller not found after ${timeout}s`,
        )
        return
      }

      // Phase 3: wait for Animate module to finish executing
      const loaded = animate.FindFirstChild('Loaded') as BoolValue | undefined
      if (loaded && !loaded.Value) {
        this.logger.Info(
          `Waiting for Animate to finish loading (gen ${generation})`,
        )
        const loadStart = os.clock()
        while (
          !loaded.Value &&
          os.clock() - loadStart < timeout &&
          generation === this.generation
        ) {
          task.wait(0.1)
        }
        if (!loaded.Value) {
          this.retryEnable(
            generation,
            `Animate not fully loaded after ${timeout}s`,
          )
          return
        }
      }

      if (generation !== this.generation) {
        this._enabling = false
        const pending = this.pendingGetGravityUp
        if (pending) this.enable(pending)
        return
      }

      // Phase 4: construct
      this.logger.Info(`Constructing gravity controller (gen ${generation})`)
      const [ok, result] = pcall(() => {
        const gc = new this.gravityControllerClass(Players.LocalPlayer)
        gc.GetGravityUp = getGravityUp
        return gc
      })
      this._enabling = false

      if (generation !== this.generation) {
        this.logger.Info(
          `Gravity controller construction completed but generation is stale (${generation} vs ${this.generation}), destroying`,
        )
        if (ok && result) result.Destroy()
        const pending = this.pendingGetGravityUp
        if (pending) this.enable(pending)
        return
      }

      if (ok && result) {
        this._controller = result
        this.pendingGetGravityUp = undefined
        this.retryCount = 0
        this.logger.Info(`Gravity controller enabled (gen ${generation})`)
      } else {
        const err =
          type(result) === 'string'
            ? result
            : tostring(result ?? 'Unknown error')
        this.logger.Error(`Error enabling gravity controller: ${err}`)
      }
    })

    // Watchdog: hard-cancel + cleanup + retry
    task.delay(timeout, () => {
      if (!this._enabling || this.generation !== generation) return

      if (this.constructionThread) {
        pcall(() => task.cancel(this.constructionThread!))
        this.constructionThread = undefined
      }
      pcall(() => RunService.UnbindFromRenderStep('GravityStep'))
      const humanoid =
        Players.LocalPlayer.Character?.FindFirstChildOfClass('Humanoid')
      if (humanoid) humanoid.PlatformStand = false

      this.retryEnable(generation, `construction timed out after ${timeout}s`)
    })
  }

  private retryEnable(generation: number, reason: string) {
    if (generation !== this.generation) return
    this._enabling = false
    this.retryCount++
    if (this.retryCount > MAX_GRAVITY_RETRIES) {
      this.logger.Error(
        `Gravity controller failed after ${this.retryCount} attempts (${reason}), giving up (gen ${generation})`,
      )
      return
    }
    this.logger.Warn(
      `Gravity controller: ${reason} (gen ${generation}), retrying (attempt ${this.retryCount}/${MAX_GRAVITY_RETRIES})`,
    )
    this.generation++
    const pending = this.pendingGetGravityUp
    if (pending) this.enable(pending)
  }
}

// ── GetGravityUp implementations ─────────────────────────────────────

const PI2 = math.pi * 2
const ZERO = new Vector3(0, 0, 0)
const LOWER_RADIUS_OFFSET = 3
const NUM_DOWN_RAYS = 24
const ODD_DOWN_RAY_START_RADIUS = 3
const EVEN_DOWN_RAY_START_RADIUS = 2
const ODD_DOWN_RAY_END_RADIUS = 1.66666
const EVEN_DOWN_RAY_END_RADIUS = 1
const NUM_FEELER_RAYS = 9
const FEELER_LENGTH = 2
const FEELER_START_OFFSET = 2
const FEELER_RADIUS = 3.5
const FEELER_APEX_OFFSET = 1
const FEELER_WEIGHTING = 8

// Thanks to EmilyBendsSpace for the new get normal function!
// https://devforum.roblox.com/t/example-source-smooth-wall-walking-gravity-controller-from-club-raven/440229?u=egomoose
export function getGroundNormal(
  cframe: CFrame,
  originOffset: Vector3,
  oldGravityUp: Vector3,
) {
  const ignoreList = []
  for (const player of Players.GetPlayers()) {
    if (player.Character) ignoreList.push(player.Character)
  }
  const origin = cframe.Position.add(originOffset)
  const radialVector =
    math.abs(cframe.LookVector.Dot(oldGravityUp)) < 0.999
      ? cframe.LookVector.Cross(oldGravityUp)
      : cframe.RightVector.Cross(oldGravityUp)
  const centerRayLength = 25
  const centerRay = new Ray(origin, oldGravityUp.mul(-centerRayLength))
  const [centerHit, _centerHitPoint, centerHitNormal] =
    game.Workspace.FindPartOnRayWithIgnoreList(centerRay, ignoreList)
  const mainDownNormal = centerHit ? centerHitNormal : ZERO
  const centerRayHitCount = 0

  let evenRayHitCount = 0
  let oddRayHitCount = 0
  let downHitCount = 0
  let downRaySum = ZERO
  for (let i = 0; i < NUM_DOWN_RAYS; i++) {
    const dtheta = PI2 * ((i - 1) / NUM_DOWN_RAYS)
    const angleWeight = 0.25 + 0.75 * math.abs(math.cos(dtheta))
    const isEvenRay = i % 2 === 0
    const startRadius = isEvenRay
      ? EVEN_DOWN_RAY_START_RADIUS
      : ODD_DOWN_RAY_START_RADIUS
    const endRadius = isEvenRay
      ? EVEN_DOWN_RAY_END_RADIUS
      : ODD_DOWN_RAY_END_RADIUS
    const downRayLength = centerRayLength
    const offset = CFrame.fromAxisAngle(oldGravityUp, dtheta).mul(radialVector)
    const dir = oldGravityUp
      .mul(-LOWER_RADIUS_OFFSET)
      .add(offset.mul(endRadius - startRadius))
    const ray = new Ray(
      origin.add(offset.mul(startRadius)),
      dir.Unit.mul(downRayLength),
    )
    const [hit, _hitPoint, hitNormal] =
      game.Workspace.FindPartOnRayWithIgnoreList(ray, ignoreList)

    if (hit) {
      downRaySum = downRaySum.add(hitNormal.mul(angleWeight))
      downHitCount = downHitCount + 1
      if (isEvenRay) {
        evenRayHitCount = evenRayHitCount + 1
      } else {
        oddRayHitCount = oddRayHitCount + 1
      }
    }
  }

  let feelerHitCount = 0
  let feelerNormalSum = ZERO
  for (let i = 0; i < NUM_FEELER_RAYS; i++) {
    const dtheta = 2 * math.pi * ((i - 1) / NUM_FEELER_RAYS)
    const angleWeight = 0.25 + 0.75 * math.abs(math.cos(dtheta))
    const offset = CFrame.fromAxisAngle(oldGravityUp, dtheta).mul(radialVector)
    const dir = offset
      .mul(FEELER_RADIUS)
      .add(oldGravityUp.mul(-LOWER_RADIUS_OFFSET)).Unit
    const feelerOrigin = origin
      .sub(oldGravityUp.mul(-FEELER_APEX_OFFSET))
      .add(dir.mul(FEELER_START_OFFSET))
    const ray = new Ray(feelerOrigin, dir.mul(FEELER_LENGTH))
    const [hit, _hitPoint, hitNormal] =
      game.Workspace.FindPartOnRayWithIgnoreList(ray, ignoreList)

    if (hit) {
      feelerNormalSum = feelerNormalSum.add(
        hitNormal.mul(FEELER_WEIGHTING * angleWeight),
      )
      feelerHitCount = feelerHitCount + 1
    }
  }

  if (centerRayHitCount + downHitCount + feelerHitCount > 0) {
    const normalSum = mainDownNormal.add(downRaySum).add(feelerNormalSum)
    if (normalSum !== ZERO) {
      return normalSum.Unit
    }
  }

  return oldGravityUp
}

export function getGravityControllerUp(
  gravityController: GravityController,
  oldGravityUp: Vector3,
) {
  return getGroundNormal(
    gravityController.HRP.CFrame,
    gravityController.Humanoid.RigType === Enum.HumanoidRigType.R15
      ? ZERO
      : oldGravityUp.mul(0.35),
    oldGravityUp,
  )
}
