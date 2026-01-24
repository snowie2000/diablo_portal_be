import { world, system, Dimension, Entity, CommandPermissionLevel, InputPermissionCategory, EntityComponentTypes, MolangVariableMap, CustomCommandParamType, GameMode, Vector3, Player, EntityLeashableComponent, EntityRideableComponent } from "@minecraft/server";

// --- Configuration ---
const PORTAL_ENTITY = "diablo:portal_marker";
const ITEM_ID = "diablo:town_scroll";
const ITEM_ID_PERMANENT = "diablo:town_scroll_permanent";
const TELEPORT_COOLDOWN_DURATION = 40; // Ticks (2 seconds)
let PORTAL_PID = 0;

// --- Portal Colors ---
const PORTAL_COLORS_NATIVE = [
    "minecraft:villager_happy",
    "minecraft:green_flame_particle",
    "minecraft:sculk_sensor_redstone_particle",
    "minecraft:redstone_repeater_dust_particle",
    //"minecraft:obsidian_glow_dust_particle",
    "minecraft:candle_flame_particle",
    "minecraft:basic_flame_particle",
    "minecraft:blue_flame_particle",
];

enum PortalType {
    Field = 0,
    Base = 1,
}

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
]

const PORTAL_INTERNAL_PARTICLE = "minecraft:end_chest";
// const PORTAL_INTERNAL_PARTICLE = "minecraft:portal_directional";
const PORTAL_COUNT = 3;
const PORTAL_INTERVAL = 3;

// --- Visual Settings ---
const PORTAL_WIDTH = 0.8;
const PORTAL_HEIGHT = 1.2;
const PARTICLES_PER_TICK = 5;

// --- Interfaces ---
interface PortalInfo {
    targetPortal: number;
    ownerId: string;
    isBase: boolean;
    linkId?: number;
    facingRot?: number;
    colorParticle?: string;
    creating?: boolean;
    createdAt?: number;
}

interface LinkInfo {
    portalA: number;
    portalB: number;
}

interface TickingAreaInfo {
    dimension: Dimension;
    location: Vector3;
    lastUsedTick: number;
}

interface PortalCreationInfo extends PortalInfo {
    locationDetermined: boolean;
    location: Vector3;
    dim: Dimension;
    pid: number;
}

// --- Runtime State (Optimized Registry) ---
const activePortals: Set<Entity> = new Set();
const playerPortals: Map<string, number> = new Map(); // PlayerID -> LinkID
const playerCooldowns: Map<string, number> = new Map(); // PlayerID -> ExpiryTick
const teleportedPlayers: Set<string> = new Set(); // PlayerID
const teleportingPlayers: Set<string> = new Set(); // PlayerID
const portalCreatingPlayers: Set<string> = new Set(); // PlayerID
const linkTable: Map<number, LinkInfo> = new Map(); // LinkID -> { portalA, portalB }
const portalInfo: Map<number, PortalCreationInfo> = new Map();
const tickingAreas: Map<string, TickingAreaInfo> = new Map();
let chunkLoaderCounter = 0;
let portalIdCounter = 0;

// Register custom command: /footsteps:trail on|off
system.beforeEvents.startup.subscribe((event) => {
    const registry = event.customCommandRegistry;

    registry.registerCommand(
        {
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
            if (!player || player.typeId !== "minecraft:player" || !(player instanceof Player)) return;

            if ((index as any) < 0 || (index as any) >= PORTAL_COLORS.length) {
                system.run(() => player.sendMessage(`§cInvalid color index. Must be between 0 and ${PORTAL_COLORS.length - 1}.`));
                return;
            }

            system.run(() => {
                player.setDynamicProperty("diablo:portal_color_index", index as any);
                player.sendMessage(`§aPortal color set to index ${index}.`);
            });
        }
    );
});

/**
 * Adds or updates a ticking area for portal loading.
 */
function addTickingArea(dim: Dimension, location: Vector3, updateOnly = false): Promise<void> {
    const name = `portal_loader_${location.x}_${location.y}_${location.z}_${dim.id}`;
    if (tickingAreas.has(name)) {
        const info = tickingAreas.get(name)!;
        info.lastUsedTick = system.currentTick;
        return Promise.resolve();
    }
    if (updateOnly) return Promise.resolve();

    tickingAreas.set(name, {
        dimension: dim,
        location,
        lastUsedTick: system.currentTick,
    });
    system.run(() => {
        dim.runCommand(
            `tickingarea add circle ${Math.floor(location.x)} ${Math.floor(
                location.y
            )} ${Math.floor(location.z)} 2 ${name} false`
        );
    });
    return Promise.resolve();
}

system.runInterval(() => {
    const currentTick = system.currentTick;
    for (const [name, info] of tickingAreas) {
        if (currentTick - info.lastUsedTick > 600) {
            system.run(() => {
                info.dimension.runCommand(`tickingarea remove ${name}`);
            });
            tickingAreas.delete(name);
        }
    }
}, 100);

function GetPortalPair(linkId: number): LinkInfo | undefined {
    return linkTable.get(linkId);
}

function setupPortal(portal: PortalCreationInfo) {
    if (portal.isBase && !portal.locationDetermined) {
        const old = { ...portal.location };
        portal.location = findSafeLocation(portal.dim, portal.location);
        portal.locationDetermined = true;
        // console.warn(`Portal ${portal.pid} repositioned from (${old.x.toFixed(2)}, ${old.y.toFixed(2)}, ${old.z.toFixed(2)}) to (${portal.location.x.toFixed(2)}, ${portal.location.y.toFixed(2)}, ${portal.location.z.toFixed(2)})`);
    }
}

function spawnPortal(dim: Dimension, location: Vector3, properties: PortalInfo): PortalCreationInfo {
    // initialize an empty portal record
    const portal: PortalCreationInfo = {
        ...properties,
        locationDetermined: false,
        pid: ++PORTAL_PID,
        location,
        dim,
    }
    // if chunk is loaded, spawn immediately, and update location if needed
    if (isChunkLoaded(dim, location)) {
        setupPortal(portal);
    }
    portalInfo.set(portal.pid, portal); // record by PID
    return portal;
}

/**
 * Initialize registry on start
 */
system.run(() => {
    ["overworld", "nether", "the_end"].forEach((dimId) => {
        try {
            const dim = world.getDimension(dimId);
            const entities = dim.getEntities({
                type: PORTAL_ENTITY,
                tags: ["active_portal"],
            });
            for (const entity of entities) {
                entity.remove(); // Clean up old portals on startup
            }
            dim.runCommand(`tickingarea remove_all`);
        } catch (e) { }
    });
});

/**
 * Track new portals spawned
 */
world.afterEvents.entitySpawn.subscribe((event) => {
    if (event.entity?.typeId === PORTAL_ENTITY) {
        activePortals.add(event.entity);
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
});

/**
 * Event: Player Leave
 */
world.afterEvents.playerLeave.subscribe((event) => {
    const linkId = playerPortals.get(event.playerId);
    if (linkId !== undefined) {
        destroyPortalPair(linkId, event.playerId);
    }
    teleportedPlayers.delete(event.playerId);
    teleportingPlayers.delete(event.playerId);
});

/**
 * Event: Item Use
 */
world.beforeEvents.itemUse.subscribe((event) => {
    const player = event.source;
    if (!(player instanceof Player)) return;
    if (event.itemStack?.typeId !== ITEM_ID && event.itemStack?.typeId !== ITEM_ID_PERMANENT) return;

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
            const oldLinkId = playerPortals.get(player.id);
            if (oldLinkId !== undefined) {
                destroyPortalPair(oldLinkId, player.id);
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

        const spawnLoc: Vector3 = {
            x: player.location.x + vx * 2,
            y: player.location.y,
            z: player.location.z + vz * 2,
        };

        const spawnPoint = player.getSpawnPoint();
        if (!spawnPoint) {
            player.sendMessage(
                "§cYou can't use the portal without a home. Go find your home now!"
            );
            player.playSound("note.bass");
            return;
        }

        if (player.isSneaking) {
            closePortal();
            return;
        }

        const targetDim = world.getDimension(spawnPoint.dimension.id);
        const initialTargetLoc: Vector3 = {
            x: spawnPoint.x + 1.5,
            y: spawnPoint.y,
            z: spawnPoint.z,
        };

        const distSq =
            Math.pow(spawnLoc.x - (spawnPoint.x + 0.5), 2) +
            Math.pow(spawnLoc.y - spawnPoint.y, 2) +
            Math.pow(spawnLoc.z - (spawnPoint.z + 0.5), 2);

        if (targetDim.id === originDim.id && distSq < 100) {
            player.sendMessage(
                "§cYou are already at home."
            );
            player.playSound("note.bass");
            return;
        }

        closePortal();
        const userColorIndex = player.getDynamicProperty("diablo:portal_color_index") as number | undefined;
        const colorIndex =
            (userColorIndex ?? Math.abs(
                player.id.split("").reduce((a, b) => (a << 5) - a + b.charCodeAt(0), 0)
            )) % PORTAL_COLORS.length;
        const colorParticle = PORTAL_COLORS[colorIndex];

        const rotY = player.getRotation().y;
        const linkId = ++portalIdCounter;
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
        fieldPortal.targetPortal = basePortal.pid;  // interlink portals
        linkTable.set(linkId, { portalA: fieldPortal.pid, portalB: basePortal.pid });
        playerPortals.set(player.id, linkId);

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
        } catch { }

        if (event.itemStack?.typeId === ITEM_ID && player.getGameMode() !== GameMode.Creative) {
            const inventory = player.getComponent("inventory")?.container;
            if (inventory) {
                const item = inventory.getItem(player.selectedSlotIndex);
                if (item?.typeId === ITEM_ID) {
                    if (item.amount > 1) {
                        item.amount--;
                        inventory.setItem(player.selectedSlotIndex, item);
                    } else {
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
    const playersInPortal = new Set<string>(teleportingPlayers);    // teleporting players are considered inside portals

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
        } catch (e) {
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

function drawPortalEffects(portal: PortalCreationInfo): void {
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

function checkPortalCollision(portal: PortalCreationInfo, currentTick: number, playersInPortal: Set<string>): void {
    const players = portal.dim.getPlayers({
        location: portal.location,
        maxDistance: 1.2,
    });

    // find players in portal area
    for (const player of players) {
        playersInPortal.add(player.id);
        if (teleportedPlayers.has(player.id)) continue; // the player has left portal before, we should wait for the player to leave

        const expiry = playerCooldowns.get(player.id);
        if (expiry !== undefined && currentTick < expiry) continue;

        const { ownerId, isBase, linkId } = portal;
        const targetPortal = portalInfo.get(portal.targetPortal);
        if (!targetPortal) continue;    // portal is broken; TODO: remove broken portals
        teleportPlayer(player, targetPortal, currentTick);

        // close portal if it's a base portal and the player is the owner
        if (player.id === ownerId && isBase && linkId !== undefined) {
            destroyPortalPair(linkId, player.id);
            player.sendMessage("§cTown Portal closed.");
        }
    }
}

function teleportPlayer(player: Player, portal: PortalCreationInfo, currentTick: number): void {
    const { location, dim } = portal;

    player.dimension.spawnParticle("diablo:teleport", player.location); // teleport start effect
    teleportedPlayers.add(player.id);
    teleportingPlayers.add(player.id);
    playerCooldowns.set(player.id, currentTick + TELEPORT_COOLDOWN_DURATION);

    const leashTag = `leash_temp_${system.currentTick}`;
    const mountTag = `mount_temp_${system.currentTick}`;
    const structName = `dp_struct_${system.currentTick}`;
    const startPos = player.location;
    const nearbyTag = `nearby_temp_${system.currentTick}`;
    // find entities leashed or mounted to the player
    const nearbyEntities = player.dimension.getEntities({
        location: player.location,
        maxDistance: 12,
    });
    const savedStructures: string[] = [];

    let leashedMobs: Set<Entity> = new Set(), mountedMobs: Set<Entity> = new Set();
    for (const mob of nearbyEntities) {
        try {
            const leashComponent = mob.getComponent(EntityComponentTypes.Leashable) as EntityLeashableComponent | undefined;
            if (leashComponent && leashComponent.leashHolder && leashComponent.leashHolder.id === player.id) {
                leashedMobs.add(mob);
            }
            const rideComponent = mob.getComponent(EntityComponentTypes.Rideable) as EntityRideableComponent | undefined;
            if (rideComponent && rideComponent.getRiders().some(rider => rider.id === player.id)) {
                rideComponent.ejectRiders();
                mountedMobs.add(mob);
            }
        } catch { }
    }

    const allMobs = [...leashedMobs, ...mountedMobs];
    const mobsSaved = !!allMobs.length;

    if (mobsSaved) {
        nearbyEntities.forEach(mob => mob.addTag(nearbyTag)); // mark all nearby mobs
        allMobs.forEach((mob, index) => {
            const sName = `${structName}_${index}`;
            const loc = mob.location;
            if (leashedMobs.has(mob)) {
                mob.addTag(leashTag);
            }
            if (mountedMobs.has(mob)) {
                mob.addTag(mountTag);
            }
            mob.dimension.runCommand(`structure save "${sName}" ${Math.floor(loc.x)} ${Math.floor(loc.y)} ${Math.floor(loc.z)} ${Math.floor(loc.x)} ${Math.floor(loc.y)} ${Math.floor(loc.z)} true memory false`);
            savedStructures.push(sName);
            mob.removeTag(leashTag);
            mob.removeTag(mountTag);
        });

        // save all mobs
        player.dimension.runCommand(`structure save "${structName}" ${Math.floor(startPos.x)} ${Math.floor(startPos.y)} ${Math.floor(startPos.z)} ${Math.floor(startPos.x)} ${Math.floor(startPos.y)} ${Math.floor(startPos.z)} true memory false`);
        nearbyEntities.forEach(mob => mob.removeTag(nearbyTag));    // remove temp tags
        allMobs.forEach(mob => mob.remove()); // remove all teleported mobs;
    }

    const restoreMobs = (targetLocation: Vector3) => {
        if (mobsSaved) {
            // release teleported mobs from structure
            savedStructures.forEach(sName => {
                dim.runCommand(`structure load "${sName}" ${targetLocation.x.toFixed(2)} ${targetLocation.y.toFixed(2)} ${targetLocation.z.toFixed(2)} 0_degrees none true false`);
            });
            const teleportedMobs = player.dimension.getEntities({
                location: player.location,
                maxDistance: 12,
                tags: [nearbyTag]
            });
            teleportedMobs.forEach(mob => {
                if (mob.hasTag(leashTag)) {
                    (mob.getComponent(EntityComponentTypes.Leashable) as EntityLeashableComponent)?.leashTo(player);
                    mob.removeTag(leashTag);
                    return;
                }
                if (mob.hasTag(mountTag)) {
                    (mob.getComponent(EntityComponentTypes.Rideable) as EntityRideableComponent)?.addRider(player);
                    mob.removeTag(mountTag);
                    return;
                }
                mob.remove();
            });
            // clean up structures
            savedStructures.forEach(sName => {
                dim.runCommand(`structure delete "${sName}"`);
            });
        }
    }

    player.teleport(location, { dimension: dim, keepVelocity: false, checkForBlocks: false });  // teleport player first, this will make minecraft load the chunk
    waitForChunkLoad(dim, location).then(() => {
        // now the chunk is loaded
        setupPortal(portal);    // setup portal if needed
        const targetLocation = portal.location;
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, false);
        player.teleport(targetLocation, { dimension: dim, keepVelocity: false, checkForBlocks: false });    // teleport again as minecraft may have moved the player slightly
        player.playSound("diablo.portal_teleport", {
            location: targetLocation,
            pitch: 1.0,
            volume: 1.0
        });
        system.runTimeout(() => {
            player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, true);
            player.teleport(targetLocation, { dimension: dim, keepVelocity: false, checkForBlocks: false });
            restoreMobs(targetLocation);
            teleportingPlayers.delete(player.id);   // teleport completed
        }, 10);
        player.dimension.spawnParticle("diablo:teleport", player.location); // teleport end effect
    });
}

function destroyPortalPair(linkId: number, ownerId: string): void {
    const portalPair = GetPortalPair(linkId);
    if (!portalPair) return;

    playerPortals.delete(ownerId);
    linkTable.delete(linkId);
    portalInfo.delete(portalPair.portalA);
    portalInfo.delete(portalPair.portalB);
}

function findSafeLocation(dim: Dimension, loc: Vector3): Vector3 {
    const maxRadius = 5;
    const dyRange = 2;

    for (let dy = 0; dy <= dyRange; dy++) {
        const yOffsets = dy === 0 ? [0] : [dy, -dy];
        for (const yOffset of yOffsets) {
            const ty = Math.floor(loc.y + yOffset);

            for (let r = 0; r <= maxRadius; r++) {
                const checkCoord = (dx: number, dz: number) => {
                    const tx = Math.floor(loc.x + dx);
                    const tz = Math.floor(loc.z + dz);
                    const blockBot = dim.getBlock({ x: tx, y: ty, z: tz });
                    const blockTop = dim.getBlock({ x: tx, y: ty + 1, z: tz });

                    if (blockBot?.isAir && blockTop?.isAir) {
                        const blockBelow = dim.getBlock({ x: tx, y: ty - 1, z: tz });
                        if (blockBelow && !blockBelow.isAir && !blockBelow.isLiquid) {
                            return { x: tx + 0.5, y: ty, z: tz + 0.5 };
                        }
                    }
                    return null;
                };

                if (r === 0) {
                    const res = checkCoord(0, 0);
                    if (res) return res;
                } else {
                    for (let i = -r; i <= r; i++) {
                        let res;
                        if ((res = checkCoord(i, -r))) return res;
                        if ((res = checkCoord(i, r))) return res;
                    }
                    for (let i = -r + 1; i < r; i++) {
                        let res;
                        if ((res = checkCoord(-r, i))) return res;
                        if ((res = checkCoord(r, i))) return res;
                    }
                }
            }
        }
    }
    return loc;
}

function isChunkLoaded(dimension: Dimension, location: Vector3): boolean {
    try {
        const block = dimension.getBlock({ x: Math.floor(location.x), y: Math.floor(location.y), z: Math.floor(location.z) });
        return !!block;
    } catch {
        return false;
    }
}

function waitForChunkLoad(dimension: Dimension, location: Vector3): Promise<void> {
    if (isChunkLoaded(dimension, location)) return Promise.resolve();

    return new Promise((resolve) => {
        let timer = system.runInterval(() => {
            if (isChunkLoaded(dimension, location)) {
                system.clearRun(timer);
                resolve();
            }
        }, 5);
    });
}

function ensureChunkLoaded(dimension: Dimension, location: Vector3, callback: () => void): Promise<void> {
    if (isChunkLoaded(dimension, location)) {
        addTickingArea(dimension, location, true);
        callback();
        return Promise.resolve();
    }

    let timeout = 100;
    const waitAndDo = (condition: () => boolean, cb: () => void) => {
        system.runTimeout(() => {
            if (condition() || --timeout <= 0) {
                cb();
            } else {
                waitAndDo(condition, cb);
            }
        }, 5);
    };

    return addTickingArea(dimension, location)
        .then(() => {
            waitAndDo(
                () => isChunkLoaded(dimension, location),
                () => {
                    system.run(() => {
                        try {
                            callback();
                        } catch { }
                    });
                }
            );
        })
        .catch(() => {
            callback();
        });
}

