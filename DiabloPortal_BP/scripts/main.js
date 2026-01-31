import { world, system, CommandPermissionLevel, InputPermissionCategory, LiquidType, EntityComponentTypes, MolangVariableMap, CustomCommandParamType, GameMode, Player } from "@minecraft/server";
// --- Configuration ---
const PORTAL_ENTITY = "diablo:portal_marker";
const ITEM_ID = "diablo:town_scroll";
const ITEM_ID_PERMANENT = "diablo:town_scroll_permanent";
const TELEPORT_COOLDOWN_DURATION = 40; // Ticks (2 seconds)
let PORTAL_PID = 0;
const NON_SOLID_BLOCKS = new Set([
    // 空气与特殊
    "minecraft:air",
    "minecraft:structure_void",
    "minecraft:light_block",
    // 植物与自然
    "minecraft:grass",
    "minecraft:tallgrass",
    "minecraft:fern",
    "minecraft:large_fern",
    "minecraft:deadbush",
    "minecraft:yellow_flower", // 蒲公英
    "minecraft:red_flower", // 玫瑰/波斯菊等
    "minecraft:torchflower",
    "minecraft:pink_petals",
    "minecraft:sugar_cane", // 甘蔗
    "minecraft:reeds", // 甘蔗的内部ID
    "minecraft:sapling",
    "minecraft:bamboo_sapling",
    "minecraft:brown_mushroom",
    "minecraft:red_mushroom",
    "minecraft:crimson_fungus",
    "minecraft:warped_fungus",
    "minecraft:crimson_roots",
    "minecraft:warped_roots",
    "minecraft:nether_sprouts",
    "minecraft:wheat",
    "minecraft:carrots",
    "minecraft:potatoes",
    "minecraft:beetroot",
    "minecraft:sweet_berry_bush",
    // 攀爬与覆盖物
    "minecraft:vine", // 藤蔓
    "minecraft:ladder", // 梯子（虽可攀爬但不可像方块一样站立）
    "minecraft:glow_lichen", // 发光地衣
    "minecraft:sculk_vein", // 幽匿脉络
    "minecraft:hanging_roots", // 垂根
    "minecraft:cave_vines", // 洞穴藤蔓
    // 红石与装饰
    "minecraft:redstone_wire",
    "minecraft:repeater",
    "minecraft:comparator",
    "minecraft:lever",
    "minecraft:torch",
    "minecraft:soul_torch",
    "minecraft:redstone_torch",
    "minecraft:tripwire",
    "minecraft:tripwire_hook",
    "minecraft:string",
    "minecraft:stone_button",
    "minecraft:wooden_button",
    "minecraft:carpet", // 地毯
    "minecraft:moss_carpet", // 苔藓地毯
    "minecraft:snow_layer", // 雪层 (高度为0时)
    // 铁轨
    "minecraft:rail",
    "minecraft:golden_rail",
    "minecraft:detector_rail",
    "minecraft:activator_rail"
]);
var PortalType;
(function (PortalType) {
    PortalType[PortalType["Field"] = 0] = "Field";
    PortalType[PortalType["Base"] = 1] = "Base";
})(PortalType || (PortalType = {}));
const PORTAL_COLORS = [
    "diablo:portal_blue",
    "diablo:portal_green",
    "diablo:portal_red",
    "diablo:portal_yellow"
];
const PORTAL_COLORS_CREATING = [
    "diablo:portal_creating_blue",
    "diablo:portal_creating_green",
    "diablo:portal_creating_red",
    "diablo:portal_creating_yellow"
];
const PORTAL_INTERNAL_PARTICLE = "minecraft:end_chest";
// const PORTAL_INTERNAL_PARTICLE = "minecraft:portal_directional";
const PORTAL_COUNT = 3;
const PORTAL_INTERVAL = 3;
// --- Visual Settings ---
const PORTAL_WIDTH = 0.8;
const PORTAL_HEIGHT = 1.2;
const PARTICLES_PER_TICK = 5;
// --- Runtime State (Optimized Registry) ---
const playerCooldowns = new Map(); // PlayerID -> ExpiryTick
const teleportedPlayers = new Set(); // PlayerID
const teleportingPlayers = new Set(); // PlayerID
const portalCreatingPlayers = new Set(); // PlayerID
const linkTable = new Map(); // LinkID -> { portalA, portalB }
const portalInfo = new Map();
function sleep(tick) {
    return new Promise((resolve) => system.runTimeout(resolve, tick));
}
// Register custom command: /footsteps:trail on|off
system.beforeEvents.startup.subscribe((event) => {
    const registry = event.customCommandRegistry;
    registry.registerCommand({
        name: "diablo:portal_color",
        description: `Set portal color index (0-${PORTAL_COLORS.length - 1})`,
        permissionLevel: CommandPermissionLevel.Any,
        mandatoryParameters: [
            {
                name: "index",
                type: CustomCommandParamType.Integer
            }
        ]
    }, 
    //@ts-ignore
    (origin, index) => {
        const player = origin.sourceEntity;
        if (!player || player.typeId !== "minecraft:player" || !(player instanceof Player))
            return;
        if (index < 0 || index >= PORTAL_COLORS.length) {
            system.run(() => player.sendMessage(`§cInvalid color index. Must be between 0 and ${PORTAL_COLORS.length - 1}.`));
            return;
        }
        system.run(() => {
            player.setDynamicProperty("diablo:portal_color_index", index);
            player.sendMessage(`§aPortal color set to index ${index}.`);
        });
    });
});
function GetPortalPair(linkId) {
    return linkTable.get(linkId);
}
function setupPortal(portal) {
    if (portal.isBase && !portal.locationDetermined) {
        const old = { ...portal.location };
        portal.location = findSafeLocation(portal.dim, portal.location);
        portal.locationDetermined = true;
        // console.warn(`Portal ${portal.pid} repositioned from (${old.x.toFixed(2)}, ${old.y.toFixed(2)}, ${old.z.toFixed(2)}) to (${portal.location.x.toFixed(2)}, ${portal.location.y.toFixed(2)}, ${portal.location.z.toFixed(2)})`);
    }
}
function spawnPortal(dim, location, properties) {
    // initialize an empty portal record
    const portal = {
        ...properties,
        locationDetermined: false,
        pid: ++PORTAL_PID,
        location: { x: location.x, y: Math.round(location.y + 0.2), z: location.z },
        dim,
    };
    // if chunk is loaded, spawn immediately, and update location if needed
    if (isChunkLoaded(dim, location)) {
        setupPortal(portal);
    }
    portalInfo.set(portal.pid, portal); // record by PID
    return portal;
}
world.afterEvents.entityDie.subscribe((event) => {
    if (event.deadEntity.typeId === "minecraft:player") {
        teleportedPlayers.add(event.deadEntity.id);
        playerCooldowns.set(event.deadEntity.id, system.currentTick + 10000); // prevent respawn player from being teleported
    }
});
/**
 * Debug: Welcome Message
 */
world.afterEvents.playerSpawn.subscribe((event) => {
    if (event.initialSpawn) {
        event.player.sendMessage("§6Diablo Portal System §av1.0.0");
    }
    teleportedPlayers.add(event.player.id);
    playerCooldowns.set(event.player.id, system.currentTick + TELEPORT_COOLDOWN_DURATION);
});
/**
 * Event: Player Leave
 */
world.afterEvents.playerLeave.subscribe((event) => {
    const linkId = event.playerId;
    if (linkId !== undefined) {
        destroyPortalPair(linkId);
    }
    teleportedPlayers.delete(event.playerId);
    teleportingPlayers.delete(event.playerId);
});
/**
 * Event: Item Use
 */
world.beforeEvents.itemUse.subscribe((event) => {
    const player = event.source;
    if (!(player instanceof Player))
        return;
    if (event.itemStack?.typeId !== ITEM_ID && event.itemStack?.typeId !== ITEM_ID_PERMANENT)
        return;
    if (portalCreatingPlayers.has(player.id)) {
        player.sendMessage("§ePortal creating in progress...");
        event.cancel = true; // Prevent spamming portal creation
        return;
    }
    // Check Cooldown
    if (player.getItemCooldown("scroll") > 0) {
        return;
    }
    // Use system.run to modify world state from a beforeEvent
    system.run(() => {
        const closePortal = () => {
            const oldLinkId = player.id;
            if (oldLinkId !== undefined) {
                destroyPortalPair(oldLinkId);
            }
        };
        const originDim = player.dimension;
        const viewDir = player.getViewDirection();
        const scaler = Math.sqrt(viewDir.x * viewDir.x + viewDir.z * viewDir.z);
        let vx = 1, vz = 1;
        if (scaler) {
            vx = viewDir.x / scaler;
            vz = viewDir.z / scaler;
        }
        const spawnLoc = {
            x: player.location.x + vx * 2,
            y: player.location.y,
            z: player.location.z + vz * 2,
        };
        const spawnPoint = player.getSpawnPoint();
        if (!spawnPoint) {
            player.sendMessage("§cYou can't use the portal without a home. Go find your home now!");
            player.playSound("note.bass");
            return;
        }
        if (player.isSneaking) {
            closePortal();
            return;
        }
        const targetDim = world.getDimension(spawnPoint.dimension.id);
        const initialTargetLoc = {
            x: spawnPoint.x + 1.5,
            y: spawnPoint.y,
            z: spawnPoint.z,
        };
        const distSq = Math.pow(spawnLoc.x - (spawnPoint.x + 0.5), 2) +
            Math.pow(spawnLoc.y - spawnPoint.y, 2) +
            Math.pow(spawnLoc.z - (spawnPoint.z + 0.5), 2);
        if (targetDim.id === originDim.id && distSq < 100) {
            player.sendMessage("§cYou are already at home.");
            player.playSound("note.bass");
            return;
        }
        closePortal();
        const userColorIndex = player.getDynamicProperty("diablo:portal_color_index");
        const colorIndex = (userColorIndex ?? Math.abs(player.id.split("").reduce((a, b) => (a << 5) - a + b.charCodeAt(0), 0))) % PORTAL_COLORS.length;
        const colorParticle = PORTAL_COLORS[colorIndex];
        const rotY = player.getRotation().y;
        const linkId = player.id;
        const fieldPortal = spawnPortal(originDim, spawnLoc, {
            targetPortal: -1,
            ownerId: player.id,
            isBase: false,
            linkId,
            facingRot: rotY,
            colorParticle,
            creating: true,
            createdAt: system.currentTick,
        });
        const basePortal = spawnPortal(targetDim, initialTargetLoc, {
            targetPortal: fieldPortal.pid,
            ownerId: player.id,
            isBase: true,
            linkId,
            facingRot: 0,
            colorParticle,
        });
        fieldPortal.targetPortal = basePortal.pid; // interlink portals
        linkTable.set(linkId, { portalA: fieldPortal.pid, portalB: basePortal.pid });
        // notify player about portal creation
        player.sendMessage("§bTown Portal opened!");
        try {
            // player.playSound("diablo.portal_create", {
            //     location: spawnLoc,
            //     pitch: 1.0,
            //     volume: 1.0
            // });
            targetDim.playSound("diablo.portal_create", initialTargetLoc, {
                pitch: 1.0,
                volume: 1.0
            });
            originDim.playSound("diablo.portal_create", spawnLoc, {
                pitch: 1.0,
                volume: 1.0
            });
        }
        catch { }
        if (event.itemStack?.typeId === ITEM_ID && player.getGameMode() !== GameMode.Creative) {
            const inventory = player.getComponent("inventory")?.container;
            if (inventory) {
                const item = inventory.getItem(player.selectedSlotIndex);
                if (item?.typeId === ITEM_ID) {
                    if (item.amount > 1) {
                        item.amount--;
                        inventory.setItem(player.selectedSlotIndex, item);
                    }
                    else {
                        inventory.setItem(player.selectedSlotIndex, undefined);
                    }
                }
            }
        }
    });
});
/**
 * Main Tick Loop
 * Every 4 ticks, scan all portals and try to setup uninitialized ones, check for collisions, and draw effects.
 */
system.runInterval(() => {
    const currentTick = system.currentTick;
    const playersInPortal = new Set(teleportingPlayers); // teleporting players are considered inside portals
    const portalList = portalInfo.values();
    for (const portal of portalList) {
        try {
            // const isPortalCreating = GetPortalProperty(portal, "creating") || false;
            // if (isPortalCreating) {
            //     drawPortalSpiralEffects(portal);
            // } else {
            if (isChunkLoaded(portal.dim, portal.location)) {
                setupPortal(portal);
                drawPortalEffects(portal);
                checkPortalCollision(portal, currentTick, playersInPortal);
            }
        }
        catch (e) {
            console.error("Portal Tick Error:", e);
        }
    }
    for (const playerId of teleportedPlayers) {
        if (!playersInPortal.has(playerId)) {
            teleportedPlayers.delete(playerId);
        }
    }
    if (playerCooldowns.size > 0) {
        for (const [playerId, expiry] of playerCooldowns) {
            if (currentTick >= expiry) {
                playerCooldowns.delete(playerId);
            }
        }
    }
}, 4);
function drawPortalEffects(portal) {
    const location = portal.location;
    const dim = portal.dim;
    const rotDeg = portal.facingRot || 0;
    const particleType = portal.colorParticle || "minecraft:blue_flame_particle";
    const vars = new MolangVariableMap();
    vars.setFloat("variable.portal_yaw", rotDeg + 180);
    dim.spawnParticle(particleType, {
        x: location.x,
        y: location.y + 1.2,
        z: location.z,
    }, vars);
}
/*
function drawPortalSpiralEffects(portal: Entity): void {
    const location = portal.location;
    const dim = portal.dimension;
    const rotDeg = (GetPortalProperty(portal, "facingRot") as number) || 0;
    const particleType = (GetPortalProperty(portal, "colorParticle") as string) || "minecraft:blue_flame_particle";

    const vars = new MolangVariableMap();
    vars.setFloat("variable.portal_yaw", rotDeg + 180);

    if (system.currentTick % 7 === 0) {
        dim.spawnParticle(particleType + "_creating", {
            x: location.x,
            y: location.y + 1.2,
            z: location.z,
        }, vars);
    }
}*/
function checkPortalCollision(portal, currentTick, playersInPortal) {
    const players = portal.dim.getPlayers({
        location: portal.location,
        maxDistance: 1.2,
    });
    // find players in portal area
    for (const player of players) {
        playersInPortal.add(player.id);
        if (teleportedPlayers.has(player.id))
            continue; // the player has left portal before, we should wait for the player to leave
        const expiry = playerCooldowns.get(player.id);
        if (expiry !== undefined && currentTick < expiry)
            continue;
        const { ownerId, isBase, linkId } = portal;
        const targetPortal = portalInfo.get(portal.targetPortal);
        if (!targetPortal)
            continue; // portal is broken; TODO: remove broken portals
        teleportPlayer(player, targetPortal, currentTick);
        // close portal if it's a base portal and the player is the owner
        if (player.id === ownerId && isBase && linkId !== undefined) {
            destroyPortalPair(linkId);
            player.sendMessage("§cTown Portal closed.");
        }
    }
}
async function teleportPlayer(player, portal, currentTick) {
    const { location, dim } = portal;
    player.dimension.spawnParticle("diablo:teleport", player.location); // teleport start effect
    teleportedPlayers.add(player.id);
    teleportingPlayers.add(player.id);
    playerCooldowns.set(player.id, currentTick + TELEPORT_COOLDOWN_DURATION);
    const leashTag = `leash_temp_${system.currentTick}`;
    const mountTag = `mount_temp_${system.currentTick}`;
    const riderTag = `rider_temp_${system.currentTick}`;
    const structName = `dp_struct_${system.currentTick}`;
    const startPos = player.location;
    const nearbyTag = `nearby_temp_${system.currentTick}`;
    // find entities leashed or mounted to the player
    const nearbyEntities = player.dimension.getEntities({
        location: player.location,
        maxDistance: 12,
    });
    const savedStructures = [];
    let leashedMobs = new Set(), mountedMobs = new Set(), riddenMobs = new Set(), allMobs = new Set();
    for (const mob of nearbyEntities) {
        try {
            const leashComponent = mob.getComponent(EntityComponentTypes.Leashable);
            if (leashComponent && leashComponent.leashHolder && leashComponent.leashHolder.id === player.id) {
                leashedMobs.add(mob);
                allMobs.add(mob);
            }
            const rideComponent = mob.getComponent(EntityComponentTypes.Rideable);
            if (rideComponent) {
                const [playerRider, ...riders] = rideComponent.getRiders();
                if (playerRider?.id === player.id) {
                    mountedMobs.add(mob);
                    riddenMobs = new Set(riders.filter(r => r.typeId !== "minecraft:player"));
                    rideComponent.ejectRiders();
                    allMobs.add(mob);
                    riddenMobs.forEach(mob => allMobs.add(mob));
                }
            }
        }
        catch { }
    }
    const mobsSaved = !!allMobs.size;
    if (mobsSaved) {
        nearbyEntities.forEach(mob => mob.addTag(nearbyTag)); // mark all nearby mobs
        Array.from(allMobs).forEach((mob, index) => {
            const sName = `${structName}_${index}`;
            const loc = mob.location;
            if (leashedMobs.has(mob)) {
                mob.addTag(leashTag);
            }
            if (mountedMobs.has(mob)) {
                mob.addTag(mountTag);
            }
            if (riddenMobs.has(mob)) {
                mob.addTag(riderTag);
            }
            mob.dimension.runCommand(`structure save "${sName}" ${Math.floor(loc.x)} ${Math.floor(loc.y)} ${Math.floor(loc.z)} ${Math.floor(loc.x)} ${Math.floor(loc.y)} ${Math.floor(loc.z)} true memory false`);
            savedStructures.push(sName);
            mob.removeTag(leashTag);
            mob.removeTag(mountTag);
            mob.removeTag(riderTag);
        });
        // save all mobs
        player.dimension.runCommand(`structure save "${structName}" ${Math.floor(startPos.x)} ${Math.floor(startPos.y)} ${Math.floor(startPos.z)} ${Math.floor(startPos.x)} ${Math.floor(startPos.y)} ${Math.floor(startPos.z)} true memory false`);
        nearbyEntities.forEach(mob => mob.removeTag(nearbyTag)); // remove temp tags
        allMobs.forEach(mob => mob.remove()); // remove all teleported mobs;
    }
    const restoreMobs = (targetLocation) => {
        if (mobsSaved) {
            // release teleported mobs from structure
            savedStructures.forEach(sName => {
                dim.runCommand(`structure load "${sName}" ${targetLocation.x.toFixed(2)} ${targetLocation.y.toFixed(2)} ${targetLocation.z.toFixed(2)} 0_degrees none true false`);
            });
            const teleportedRiders = [];
            let teleportedMount;
            const teleportedMobs = player.dimension.getEntities({
                location: player.location,
                maxDistance: 12,
                tags: [nearbyTag]
            });
            teleportedMobs.forEach(mob => {
                let dumyMob = true;
                if (mob.hasTag(leashTag)) {
                    mob.getComponent(EntityComponentTypes.Leashable)?.leashTo(player);
                    mob.removeTag(leashTag);
                    dumyMob = false;
                }
                if (mob.hasTag(mountTag)) {
                    mob.getComponent(EntityComponentTypes.Rideable)?.addRider(player);
                    mob.removeTag(mountTag);
                    teleportedMount = mob;
                    dumyMob = false;
                }
                if (mob.hasTag(riderTag)) {
                    teleportedRiders.push(mob);
                    mob.removeTag(riderTag);
                    dumyMob = false;
                }
                if (dumyMob)
                    mob.remove();
            });
            // re-attach riders to mount
            if (teleportedMount) {
                const rideComponent = teleportedMount.getComponent(EntityComponentTypes.Rideable);
                teleportedRiders.forEach(rider => rideComponent?.addRider(rider));
            }
            // clean up structures
            savedStructures.forEach(sName => {
                dim.runCommand(`structure delete "${sName}"`);
            });
        }
    };
    player.camera.fade({
        fadeColor: { red: 1, green: 1, blue: 1 },
        fadeTime: {
            fadeInTime: 0.1,
            fadeOutTime: 0.5,
            holdTime: 0.8
        }
    });
    await sleep(2);
    player.teleport(location, { dimension: dim, keepVelocity: false, checkForBlocks: false }); // teleport player first, this will make minecraft load the chunk
    waitForChunkLoad(dim, location).then(() => {
        // now the chunk is loaded
        setupPortal(portal); // setup portal if needed
        const targetLocation = portal.location;
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, false);
        player.teleport(targetLocation, { dimension: dim, keepVelocity: false, checkForBlocks: false }); // teleport again as minecraft may have moved the player slightly
        system.runTimeout(() => {
            player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, true);
            player.teleport(targetLocation, { dimension: dim, keepVelocity: false, checkForBlocks: false });
            restoreMobs(targetLocation);
            teleportingPlayers.delete(player.id); // teleport completed
        }, 10);
        system.run(() => {
            player.playSound("diablo.portal_teleport", {
                location: targetLocation,
                pitch: 1.0,
                volume: 1.0
            });
        });
    });
}
function destroyPortalPair(linkId) {
    const portalPair = GetPortalPair(linkId);
    if (!portalPair)
        return;
    linkTable.delete(linkId);
    portalInfo.delete(portalPair.portalA);
    portalInfo.delete(portalPair.portalB);
}
function isSolidBlock(b) {
    return b.isValid && !b.isAir && !b.isLiquid &&
        !b.permutation.canBeDestroyedByLiquidSpread(LiquidType.Water) && !NON_SOLID_BLOCKS.has(b.typeId);
}
function findSafeLocation(dim, loc) {
    let searchCenter = { ...loc };
    // 1. Search in a 3x3x3 area around loc for a bed or a respawn anchor
    const range = 3;
    let found = false;
    for (let dx = -range; dx <= range && !found; dx++) {
        for (let dy = -range; dy <= range && !found; dy++) {
            for (let dz = -range; dz <= range && !found; dz++) {
                try {
                    const block = dim.getBlock({
                        x: Math.floor(loc.x + dx),
                        y: Math.floor(loc.y + dy),
                        z: Math.floor(loc.z + dz)
                    });
                    if (block && (block.typeId.includes("bed") || block.typeId === "minecraft:respawn_anchor")) {
                        searchCenter = {
                            x: block.location.x + 0.5,
                            y: block.location.y,
                            z: block.location.z + 0.5
                        };
                        found = true;
                    }
                }
                catch (e) { }
            }
        }
    }
    const maxRadius = 5;
    const dyRange = 2;
    for (let dy = 0; dy <= dyRange; dy++) {
        const yOffsets = dy === 0 ? [0] : [dy, -dy];
        for (const yOffset of yOffsets) {
            const ty = Math.floor(searchCenter.y + yOffset);
            for (let r = 0; r <= maxRadius; r++) {
                const checkCoord = (dx, dz) => {
                    const tx = Math.floor(searchCenter.x + dx);
                    const tz = Math.floor(searchCenter.z + dz);
                    const blockBot = dim.getBlock({ x: tx, y: ty, z: tz });
                    const blockTop = dim.getBlock({ x: tx, y: ty + 1, z: tz });
                    if (blockBot?.isAir && blockTop?.isAir) {
                        const blockBelow = dim.getBlock({ x: tx, y: ty - 1, z: tz });
                        const blockBelow2 = dim.getBlock({ x: tx, y: ty - 2, z: tz });
                        if (blockBelow && isSolidBlock(blockBelow)) {
                            return { x: tx + 0.5, y: ty, z: tz + 0.5 };
                        }
                        if (blockBelow2 && isSolidBlock(blockBelow2)) {
                            return { x: tx + 0.5, y: ty - 1, z: tz + 0.5 };
                        }
                    }
                    // dim.spawnParticle("minecraft:mobflame_emitter", { x: tx + 0.5, y: ty + 1, z: tz + 0.5 });
                    return null;
                };
                if (r === 0) {
                    const res = checkCoord(0, 0);
                    if (res)
                        return res;
                }
                else {
                    for (let i = -r; i <= r; i++) {
                        let res;
                        if ((res = checkCoord(i, -r)))
                            return res;
                        if ((res = checkCoord(i, r)))
                            return res;
                    }
                    for (let i = -r + 1; i < r; i++) {
                        let res;
                        if ((res = checkCoord(-r, i)))
                            return res;
                        if ((res = checkCoord(r, i)))
                            return res;
                    }
                }
            }
        }
    }
    return searchCenter;
}
function isChunkLoaded(dimension, location) {
    try {
        const block = dimension.getBlock({ x: Math.floor(location.x), y: Math.floor(location.y), z: Math.floor(location.z) });
        return !!block;
    }
    catch {
        return false;
    }
}
function waitForChunkLoad(dimension, location) {
    if (isChunkLoaded(dimension, location))
        return Promise.resolve();
    return new Promise((resolve) => {
        let timer = system.runInterval(() => {
            if (isChunkLoaded(dimension, location)) {
                system.clearRun(timer);
                resolve();
            }
        }, 5);
    });
}
