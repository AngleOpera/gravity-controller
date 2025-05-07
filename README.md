# @rbxts/gravity-controller

Typescript bindings for [EgoMoose's Rbx-Gravity-Controller](https://github.com/EgoMoose/Rbx-Gravity-Controller) with
ground normal finding by [EmilyBendsSpace](https://x.com/EmilyBendsSpace)

## Flamework setup

1. Add `installGravityControllerClass` to the `onInit` of some `@Service`

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

2. Setup a `GravityController` in some `@Controller`

```typescript
import { Controller, OnStart } from '@flamework/core'
import {
  getGravityControllerUp,
  GravityController,
  GravityControllerClass,
  installGravityControllerClass,
} from '@rbxts/gravity-controller'
import { Players } from '@rbxts/services'

@Controller({})
export class PlayerGravityController implements OnStart {
  gravityControllerClass: GravityControllerClass | undefined
  gravityController: GravityController | undefined

  onStart() {
    this.gravityControllerClass = installGravityControllerClass()
    Players.LocalPlayer.CharacterAdded.Connect((_character) => {
      this.disableGravityController()
      this.enableGravityController()
    })
  }

  disableGravityController() {
    this.gravityController?.Destroy()
    this.gravityController = undefined
  }

  enableGravityController() {
    if (this.gravityController || !this.gravityControllerClass) return
    const gravityController = new this.gravityControllerClass(Players.LocalPlayer)

    // Use EmilyBendsSpace's getGroundNormal() to walk up walls
    gravityController.GetGravityUp = getGravityControllerUp

    this.gravityController = gravityController
  }
}

```
