import { world, system, Dimension, Entity, CommandPermissionLevel, MolangVariableMap, CustomCommandParamType, GameMode } from "@minecraft/server";

// --- Configuration ---
const PORTAL_ENTITY = "diablo:portal_marker";
const ITEM_ID = "diablo:town_scroll";
const ITEM_ID_PERMANENT = "diablo:town_scroll_permanent";
const TELEPORT_COOLDOWN_DURATION = 40; // Ticks (2 seconds)

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

// --- Runtime State (Optimized Registry) ---
/** @type {Set<import("@minecraft/server").Entity>} */
const activePortals = new Set();
const playerPortals = new Map(); // PlayerID -> LinkID
const playerCooldowns = new Map(); // PlayerID -> ExpiryTick
const teleportedPlayers = new Set(); // PlayerID
const portalCreatingPlayers = new Set(); // PlayerID
const linkTable = new Map(); // LinkID -> { portalA: Entity, portalB: Entity }
const portalInfo = new Map(); // Entity -> { targetLoc, targetDimId, ownerId, isBase, linkId, colorParticle }
const tickingAreas = new Map();
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
    (origin, index) => {
      const player = origin.entity || origin.sourceEntity;
      if (!player || player.typeId !== "minecraft:player") return;

      if (index < 0 || index >= PORTAL_COLORS.length) {
        system.run(() => player.sendMessage(`§cInvalid color index. Must be between 0 and ${PORTAL_COLORS.length - 1}.`));
        return;
      }

      system.run(() => {
        player.setDynamicProperty("diablo:portal_color_index", index);
        player.sendMessage(`§aPortal color set to index ${index}.`);
      });
    }
  );
});


/**
 *
 * @param {import("@minecraft/server").Dimension} dim
 * @param {import("@minecraft/server").Vector3} location
 * @param {boolean} updateOnly
 */
function addTickingArea(dim, location, updateOnly = false) {
  const name = `portal_loader_${location.x}_${location.y}_${location.z}_${dim.id}`;
  if (tickingAreas.has(name)) {
    const info = tickingAreas.get(name);
    info.lastUsedTick = system.currentTick;
    return Promise.resolve();
  }
  if (updateOnly) return Promise.resolve();

  tickingAreas.set(name, {
    dimension: dim,
    location,
    lastUsedTick: system.currentTick,
  });
  dim.runCommand(
    `tickingarea add circle ${Math.floor(location.x)} ${Math.floor(
      location.y
    )} ${Math.floor(location.z)} 2 ${name} false`
  );
  return Promise.resolve();
}

system.runInterval(() => {
  const currentTick = system.currentTick;
  for (const [name, info] of tickingAreas) {
    if (currentTick - info.lastUsedTick > 600) {
      info.dimension.runCommand(`tickingarea remove ${name}`);
      // console.log(`Removed unused ticking area: ${name}`);
      tickingAreas.delete(name);
    }
  }
}, 100);

/**
 *
 * @param {Entity} portal
 * @returns
 */
function GetLinkId(portal) {
  return GetPortalProperty(portal, "linkId");
}

/**
 *
 * @param {Entity} portal
 * @param {string} property
 * @returns
 */
function GetPortalProperty(portal, property) {
  const p = portalInfo.get(portal);
  return p ? p[property] : undefined;
}

/**
 *
 * @param {number} linkId
 * @returns
 */
function GetPortalPair(linkId) {
  return linkTable.get(linkId);
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
  event.player.sendMessage("§6Portal System Loaded (Optimized)");
});

/**
 * Event: Player Leave
 * Destroy portals belonging to the player who left.
 */
world.afterEvents.playerLeave.subscribe((event) => {
  const linkId = playerPortals.get(event.playerId);
  if (linkId !== undefined) {
    destroyPortalPair(linkId);
  }
  teleportedPlayers.delete(event.playerId);
});

/**
 * Event: Item Use
 */
world.beforeEvents.itemUse.subscribe((event) => {
  const player = event.source;
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
    // Diablo logic: One portal per player. Close old one if it exists.
    const oldLinkId = playerPortals.get(player.id);
    if (oldLinkId !== undefined) {
      destroyPortalPair(oldLinkId);
      // player.sendMessage("§eOld portal closed to open a new one.");
    }

    const originDim = player.dimension;
    const viewDir = player.getViewDirection();
    const scaler = Math.sqrt(viewDir.x * viewDir.x + viewDir.z * viewDir.z);
    viewDir.x /= scaler;
    viewDir.z /= scaler;
    const spawnLoc = {
      x: player.location.x + viewDir.x * 2,
      y: player.location.y,
      z: player.location.z + viewDir.z * 2,
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
      return; // close the portal without creating a new one
    }

    const targetDim = world.getDimension(spawnPoint.dimension.id);
    const initialTargetLoc = {
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
        "§cYou are already near your home. The portal fizzles out."
      );
      return;
    }

    // Determine unique color for player
    const userColorIndex = player.getDynamicProperty("diablo:portal_color_index");
    const colorIndex =
      (userColorIndex ?? Math.abs(
        player.id.split("").reduce((a, b) => (a << 5) - a + b.charCodeAt(0), 0)
      )) % PORTAL_COLORS.length;
    const colorParticle = PORTAL_COLORS[colorIndex];
    // console.warn(colorParticle);
    const rotY = player.getRotation().y;
    const linkId = ++portalIdCounter;
    const fieldPortal = originDim.spawnEntity(PORTAL_ENTITY, spawnLoc); // entrance portal
    setupPortalData(fieldPortal, {
      ownerId: player.id,
      isBase: false,
      linkId,
      facingRot: rotY,
      colorParticle,
      creating: true,
      createdAt: system.currentTick,
    });

    // Consume scroll if not permanent and not in creative
    // console.log(player.getGameMode(), GameMode.creative)
    if (event.itemStack.typeId === ITEM_ID && player.getGameMode() !== GameMode.Creative) {
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

    // Spawn Portals
    portalCreatingPlayers.add(player.id);
    // Ensure the home chunk is loaded before spawning the base portal
    ensureChunkLoaded(targetDim, initialTargetLoc, () => {
      const targetLoc = findSafeLocation(targetDim, initialTargetLoc);

      const basePortal = targetDim.spawnEntity(PORTAL_ENTITY, targetLoc); // return portal

      playerPortals.set(player.id, linkId);

      setupPortalData(fieldPortal, {
        targetLoc,
        targetDim: targetDim.id,
        ownerId: player.id,
        isBase: false,
        linkId,
        dimId: originDim.id,
        facingRot: rotY,
        colorParticle,
      });
      setupPortalData(basePortal, {
        targetLoc: spawnLoc,
        targetDim: originDim.id,
        ownerId: player.id,
        isBase: true,
        linkId,
        dimId: targetDim.id,
        facingRot: 0,
        colorParticle,
      });
      // Register in link tables
      linkTable.set(linkId, { portalA: fieldPortal, portalB: basePortal });

      player.sendMessage("§bTown Portal opened!");
      player.playSound("mob.illusioner.cast_spell");
      portalCreatingPlayers.delete(player.id);
    });
  });
});

/**
 * Sets up and stores portal metadata using dynamic properties and tags.
 * @param {import("@minecraft/server").Entity} entity - The portal entity to configure.
 * @param {import("@minecraft/server").Vector3} targetLoc - Destination coordinates.
 * @param {string} targetDim - Destination dimension identifier.
 * @param {string} ownerId - Unique identifier of the player who created the portal.
 * @param {boolean} isBase - Whether this is the portal at the player's spawn point.
 * @param {number} linkId - Shared ID linking the two portals in a pair.
 * @param {number} rotationY - The Y-axis rotation for visual alignment.
 * @param {string} colorParticle - The particle type to use for this portal's color.
 */
function setupPortalData(entity, properties) {
  if (!entity || !entity.isValid) return;
  portalInfo.set(entity, properties);
  activePortals.add(entity);
}

/**
 * Main Tick Loop
 */
system.runInterval(() => {
  const currentTick = system.currentTick;

  const playersInPortal = new Set(playerCooldowns.keys());
  // 1. Process active portals
  for (const portal of activePortals) {
    if (!portal.isValid) {
      // activePortals.delete(portal);
      continue;
    }

    try {
      const isPortalCreating = GetPortalProperty(portal, "creating") || false;
      if (isPortalCreating) {
        drawPortalSpiralEffects(portal);
      } else {
        drawPortalEffects(portal);
        checkPortalCollision(portal, currentTick, playersInPortal); // check and collect players in portal
      }
    } catch (e) {
      console.info("Portal Tick Error:", e);
    }
  }

  for (const playerId of teleportedPlayers) {
    if (!playersInPortal.has(playerId)) {
      teleportedPlayers.delete(playerId);
    }
  }

  // 2. Cooldown Cleanup (Map is much faster than tags + proximity checks)
  if (playerCooldowns.size > 0) {
    for (const [playerId, expiry] of playerCooldowns) {
      if (currentTick >= expiry) {
        playerCooldowns.delete(playerId);
      }
    }
  }
}, 4);

/**
 * Renders the visual particle ring for a portal.
 * @param {import("@minecraft/server").Entity} portal - The portal entity to draw effects around.
 */
function drawPortalEffects(portal) {
  const location = portal.location;
  const dim = portal.dimension;
  const centerY = location.y + 1.8;
  const rotDeg = GetPortalProperty(portal, "facingRot") || 0;
  const rad = rotDeg * (Math.PI / 180);
  const particleType =
    GetPortalProperty(portal, "colorParticle") ||
    "minecraft:blue_flame_particle";

  const vars = new MolangVariableMap();
  vars.setFloat("variable.portal_yaw", rotDeg + 180);

  dim.spawnParticle(particleType, {
    x: location.x,
    y: location.y + 1.2,
    z: location.z,
  }, vars);
  return;

  // Cached trig values
  const cosRad = Math.cos(rad);
  const sinRad = Math.sin(rad);

  if (!isChunkLoaded(dim, location)) return; // Skip if chunk not loaded

  for (let i = 0; i < PARTICLES_PER_TICK; i++) {
    const angle = Math.random() * 2 * Math.PI;
    const localX = Math.cos(angle) * PORTAL_WIDTH;
    const localY = Math.sin(angle) * PORTAL_HEIGHT;

    dim.spawnParticle(particleType, {
      x: location.x + localX * cosRad,
      y: centerY + localY,
      z: location.z + localX * sinRad,
    });
  }

  if (system.currentTick % PORTAL_INTERVAL === 0) {
    for (let i = 0; i < PORTAL_COUNT; i++) {
      const angle = Math.random() * 2 * Math.PI;
      const localX = Math.cos(angle) * PORTAL_WIDTH * Math.random();
      const localY = Math.sin(angle) * PORTAL_HEIGHT * Math.random();
      dim.spawnParticle(PORTAL_INTERNAL_PARTICLE, {
        x: location.x + localX * cosRad,
        y: centerY + localY,
        z: location.z + localX * sinRad,
      });
    }
  }
}

/**
 * Renders a spiral particle pattern radiating outward from the portal.
 * @param {import("@minecraft/server").Entity} portal
 */
function drawPortalSpiralEffects2(portal) {
  const location = portal.location;
  const centerY = location.y + 1.2;
  const rotDeg = GetPortalProperty(portal, "facingRot") || 0;
  const createdAt = GetPortalProperty(portal, "createdAt") || 0;
  const portalScale = Math.min(1.0, (system.currentTick - createdAt) / 30);
  const rad = rotDeg * (Math.PI / 180);
  const particleType =
    // GetPortalProperty(portal, "colorParticle") ||
    "minecraft:blue_flame_particle";

  const cosRad = Math.cos(rad);
  const sinRad = Math.sin(rad);
  const dim = portal.dimension;

  if (!isChunkLoaded(dim, location)) return; // avoid drawing in unloaded chunks
  // Horizontal vortex with 3 continuous spiral arms
  const t = system.currentTick * 0.03; // time-based animation
  const numArms = 3;
  const pointsPerArm = Math.ceil(PARTICLES_PER_TICK / numArms);

  for (let arm = 0; arm < numArms; arm++) {
    const armAngleOffset = (arm / numArms) * Math.PI * 2; // distribute 3 arms evenly

    for (let j = 0; j < pointsPerArm; j++) {
      // Progress along this arm from outer edge (0) to center (1)
      const progress = (j / pointsPerArm + t) % 1;

      // Spiral angle: starts at arm's base angle and spirals inward
      const spiralAmount = progress * Math.PI * 1; // how much the arm curves as it goes inward
      const angle = armAngleOffset - spiralAmount; // negative for inward spiral

      // Radius decreases as we move toward center
      const radius = PORTAL_WIDTH * portalScale * (1 - progress * 0.85);

      // Local coordinates in the portal plane
      const localX = Math.cos(angle) * radius;
      const localY = Math.sin(angle) * radius * (PORTAL_HEIGHT / PORTAL_WIDTH);

      // Transform to world space with slight depth variation
      const depthOffset = (1 - progress) * 0.2;

      const worldX = location.x + localX * cosRad - depthOffset * sinRad;
      const worldY = centerY + localY;
      const worldZ = location.z + localX * sinRad + depthOffset * cosRad;

      dim.spawnParticle(particleType, {
        x: worldX,
        y: worldY,
        z: worldZ,
      });
    }
  }
}

/**
 * Renders a spiral particle pattern radiating outward from the portal.
 * @param {import("@minecraft/server").Entity} portal
 */
function drawPortalSpiralEffects(portal) {
  const location = portal.location;
  const dim = portal.dimension;
  const centerY = location.y + 1.8;
  const rotDeg = GetPortalProperty(portal, "facingRot") || 0;
  const rad = rotDeg * (Math.PI / 180);
  const particleType =
    GetPortalProperty(portal, "colorParticle") ||
    "minecraft:blue_flame_particle";

  const vars = new MolangVariableMap();
  vars.setFloat("variable.portal_yaw", rotDeg + 180);

  if (system.currentTick % 7 === 0) {
    dim.spawnParticle(particleType + "_creating", {
      x: location.x,
      y: location.y + 1.2,
      z: location.z,
    }, vars);
  }
  return;
}

/**
 * Checks for player contact with the portal and handles teleportation logic.
 * @param {import("@minecraft/server").Entity} portal - The portal entity to check.
 * @param {number} currentTick - The current system tick for cooldown management.
 */
function checkPortalCollision(portal, currentTick, playersInPortal) {
  const players = portal.dimension.getPlayers({
    location: portal.location,
    maxDistance: 1.2,
  });

  for (const player of players) {
    playersInPortal.add(player.id);
    if (teleportedPlayers.has(player.id)) {
      continue; // the player is still in the portal, not moved away
    }
    const expiry = playerCooldowns.get(player.id);
    if (expiry !== undefined && currentTick < expiry) continue;

    const ownerId = GetPortalProperty(portal, "ownerId");
    const isBase = GetPortalProperty(portal, "isBase");
    const linkId = GetLinkId(portal);

    if (player.id === ownerId && isBase) {
      const targetLoc = GetPortalProperty(portal, "targetLoc");
      const targetDim = world.getDimension(
        GetPortalProperty(portal, "targetDim")
      );

      destroyPortalPair(linkId); // destroy portal pairs before teleporting
      teleportPlayer(player, targetLoc, targetDim, currentTick);
      player.sendMessage("§cTown Portal closed.");
      return;
    }

    teleportPlayerToPortal(player, portal, currentTick);
  }
}

/**
 * Teleports a player to the portal's target destination.
 * @param {import("@minecraft/server").Player} player - The player to teleport.
 * @param {import("@minecraft/server").Entity} portal - The portal providing destination data.
 * @param {number} currentTick - The current system tick to set the cooldown.
 */
function teleportPlayerToPortal(player, portal, currentTick) {
  const targetLoc = GetPortalProperty(portal, "targetLoc");
  const targetDim = world.getDimension(GetPortalProperty(portal, "targetDim"));

  teleportPlayer(player, targetLoc, targetDim, currentTick);
}

/**
 *
 * @param {import("@minecraft/server").Player} player
 * @param {import("@minecraft/server").Vector3} location
 * @param {import("@minecraft/server").Dimension} dim
 * @param {number} currentTick
 */
function teleportPlayer(player, location, dim, currentTick) {
  if (teleportedPlayers.has(player.id)) return; // already teleporting

  const currentDim = player.dimension;

  const intervalId = system.runInterval(() => {
    try {
      currentDim.spawnParticle("diablo:teleport", player.location);
    } catch {
      system.clearRun(intervalId);
    }
  }, 20);

  teleportedPlayers.add(player.id);
  ensureChunkLoaded(dim, location, () => {
    system.clearRun(intervalId);
    playerCooldowns.set(player.id, currentTick + TELEPORT_COOLDOWN_DURATION);
    player.teleport(location, { dimension: dim });
    player.playSound("mob.endermen.portal");
  });
}

/**
 * Removes both portals in a pair based on their shared Link ID.
 * @param {number} linkId - The shared identifier of the portal pair to destroy.
 */
function destroyPortalPair(linkId) {
  // this portal must be in a loaded chunk, so we can use it to find the pair
  const portalPair = GetPortalPair(linkId);
  if (!portalPair) return;

  const ownerId = GetPortalProperty(portalPair.portalA, "ownerId");
  const dimA = world.getDimension(
    GetPortalProperty(portalPair.portalA, "dimId")
  );
  const locA = GetPortalProperty(portalPair.portalB, "targetLoc");
  const dimB = world.getDimension(
    GetPortalProperty(portalPair.portalB, "dimId")
  );
  const locB = GetPortalProperty(portalPair.portalA, "targetLoc");

  // load chunk and remove portals
  ensureChunkLoaded(dimA, locA, () => {
    try {
      activePortals.delete(portalPair.portalA);
      portalPair.portalA.remove();
    } catch { }
  });

  ensureChunkLoaded(dimB, locB, () => {
    try {
      activePortals.delete(portalPair.portalB);
      portalPair.portalB.remove();
    } catch { }
  });

  // unregister from tables
  playerPortals.delete(ownerId);
  linkTable.delete(linkId);
  portalInfo.delete(portalPair.portalA);
  portalInfo.delete(portalPair.portalB);
}

/**
 * Finds a safe location for a portal to spawn using a spiral search pattern.
 * Prioritizes proximity to the original location (bed/spawn point).
 * @param {import("@minecraft/server").Dimension} dim - The dimension to check.
 * @param {import("@minecraft/server").Vector3} loc - The starting center location.
 * @returns {import("@minecraft/server").Vector3} A safe spawn location.
 */
function findSafeLocation(dim, loc) {
  const maxRadius = 5;
  const dyRange = 2;

  for (let r = 0; r <= maxRadius; r++) {
    for (let dy = 0; dy <= dyRange; dy++) {
      const yOffsets = dy === 0 ? [0] : [dy, -dy];
      for (const yOffset of yOffsets) {
        const ty = Math.floor(loc.y + yOffset);

        // Helper to check a specific XZ coordinate
        const checkCoord = (dx, dz) => {
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
          // Check edges of the square square at radius r
          for (let i = -r; i <= r; i++) {
            let res;
            if ((res = checkCoord(i, -r))) return res; // Top
            if ((res = checkCoord(i, r))) return res; // Bottom
          }
          for (let i = -r + 1; i < r; i++) {
            let res;
            if ((res = checkCoord(-r, i))) return res; // Left
            if ((res = checkCoord(r, i))) return res; // Right
          }
        }
      }
    }
  }
  return loc; // Fallback to original if no better spot found
}

/**
 *
 * @param {import("@minecraft/server").Dimension} dimension
 * @param {import("@minecraft/server").Vector3} location
 * @returns
 */
function isChunkLoaded(dimension, location) {
  const x = Math.floor(location.x);
  const y = Math.floor(location.y);
  const z = Math.floor(location.z);
  try {
    const block = dimension.getBlock({ x, y, z }); // Accessing a block forces chunk load
    return !!block;
  } catch {
    return false;
  }
}

/**
 * Forces a chunk at the specified location to load by creating a temporary ticking area,
 * then executes a callback once the area is active.
 * @param {import("@minecraft/server").Dimension} dimension - The dimension to load.
 * @param {import("@minecraft/server").Vector3} location - The location to ensure is loaded.
 * @param {Function} callback - The function to execute after the chunk loads.
 */
function ensureChunkLoaded(dimension, location, callback) {
  if (isChunkLoaded(dimension, location)) {
    addTickingArea(dimension, location, true); // update ticking area to avoid being recycled
    callback(); // Already loaded, direct call
    return Promise.resolve();
  }

  let timeout = 100; // max attempts
  const waitAndDo = (condition, callback) => {
    system.runTimeout(() => {
      if (condition() || --timeout <= 0) {
        callback();
      } else {
        waitAndDo(condition, callback);
      }
    }, 5);
  };

  return addTickingArea(dimension, location)
    .then(() => {
      waitAndDo(
        () => isChunkLoaded(dimension, location),
        () => {
          system.run(async () => {
            try {
              await callback();
            } catch { }
          });
        }
      );
    })
    .catch(() => {
      // Fallback if ticking areas are full or command fails
      callback();
    });
}

/**
 * Garbage Collection: Remove orphaned portals not in registry
 */
system.runInterval(() => {
  const activeIds = new Set();
  for (const portal of activePortals) {
    if (portal.isValid) activeIds.add(portal.id);
  }

  ["overworld", "nether", "the_end"].forEach((dimId) => {
    try {
      const dim = world.getDimension(dimId);
      const entities = dim.getEntities({ type: PORTAL_ENTITY });
      for (const entity of entities) {
        if (!activeIds.has(entity.id)) {
          entity.remove();
        }
      }
    } catch (e) { }
  });
}, 200);
