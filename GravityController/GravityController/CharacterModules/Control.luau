-- Class

local ControlClass = {}
ControlClass.__index = ControlClass
ControlClass.ClassName = "Control"

-- Public Constructors

function ControlClass.new(controller)
	local self = setmetatable({}, ControlClass)

	local player = controller.Player
	local pmScript = player.PlayerScripts:WaitForChild("PlayerModule", 5)
	if not pmScript then error("PlayerModule not found after 5s") end
	local playerModule = require(pmScript)

	self.Controller = controller
	self.ControlModule = playerModule:GetControls()

	return self
end

-- Public Methods

function ControlClass:GetMoveVector()
	return self.ControlModule:GetMoveVector()
end

function ControlClass:Destroy()
	
end

--

return ControlClass