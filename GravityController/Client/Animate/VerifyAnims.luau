local LENGTH = string.len("Animation")

local DESC_ANIM_PROPS = {
	["ClimbAnimation"] = true,
	["FallAnimation"] = true,
	["IdleAnimation"] = true,
	["JumpAnimation"] = true,
	["RunAnimation"] = true,
	["SwimAnimation"] = true,
	["WalkAnimation"] = true,
}

return function(humanoid, animate)
	local desc = humanoid:GetAppliedDescription()
	
	if humanoid.RigType == Enum.HumanoidRigType.R6 then
		return
	end
	
	for prop, _ in pairs(DESC_ANIM_PROPS) do
		if desc[prop] > 0 then
			local lookFor = prop:sub(1, #prop - LENGTH):lower()
			local child = animate:WaitForChild(lookFor, 5)
			if not child then
				warn("VerifyAnims: " .. lookFor .. " not found after 5s, skipping")
			end
		end
	end
end