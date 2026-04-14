-- Injects into the CameraModule for public API access
-- Based on EgoMoose/patch-roblox-cameramodule (modern approach using debug.info)

local PlayerModule = script.Parent.Parent:WaitForChild("PlayerModule")
local CameraModule = PlayerModule:WaitForChild("CameraModule")
local TransparencyController = require(CameraModule:WaitForChild("TransparencyController"))

local result = nil
local thread = coroutine.running()
local oldNew = TransparencyController.new

TransparencyController.new = function(...)
	TransparencyController.new = oldNew

	-- debug.info(2, "f") gets the calling function: CameraModule.new
	local cameraModuleNew = debug.info(2, "f")
	result = cameraModuleNew()

	-- Resume the waiting main thread
	if coroutine.status(thread) == "suspended" then
		task.spawn(thread)
	end

	-- Yield forever so the original CameraModule initialization doesn't double-run
	coroutine.yield()
end

task.spawn(function()
	require(CameraModule)
end)

while not result do
	coroutine.yield()
end

-- Place children under injection

for _, child in pairs(CameraModule:GetChildren()) do
	child.Parent = script
end

CameraModule.Name = "_CameraModule"
script.Name = "CameraModule"
script.Parent = PlayerModule

return result
