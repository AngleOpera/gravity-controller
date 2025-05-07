import {
  Players,
  ReplicatedStorage,
  RunService,
  StarterPlayer,
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
  GetGravityUp(self: GravityController, oldGravityUp: Vector3): void
  ResetGravity(gravityDirection: Vector3): void
}

export interface GravityControllerClass {
  new (player: Player): GravityController
}

export let gravityControllerClass: GravityControllerClass

export function installGravityControllerClass() {
  if (gravityControllerClass) return gravityControllerClass
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
  return gravityControllerClass
}

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
