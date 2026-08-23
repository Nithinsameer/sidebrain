'use strict';

const crypto = require('node:crypto');
const { TaskServiceError } = require('./task-service');

const LIGHT_TYPES = new Set(['devices.types.light']);
const USEFUL = new Set([
  'devices.capabilities.on_off:powerSwitch',
  'devices.capabilities.range:brightness',
  'devices.capabilities.color_setting:colorRgb',
  'devices.capabilities.color_setting:colorTemperatureK',
  'devices.capabilities.dynamic_scene:lightScene',
  'devices.capabilities.dynamic_scene:diyScene',
  'devices.capabilities.diy_color_setting:diyScene',
  'devices.capabilities.dynamic_scene:snapshot',
]);
const SCENE_INSTANCES = new Set(['lightScene', 'diyScene', 'snapshot']);
const DISRUPTIVE_SCENE = /\b(?:alarm|emergency|flash|flashing|lightning|police|strobe)\b/i;

function fail(code, message) { throw new TaskServiceError(code, message); }
function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function assertKeys(value, allowed) {
  if (!isObject(value)) fail('invalid_request', 'request must be an object');
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('invalid_request', 'request contains an unsupported field');
}
function safeText(value, maximum, name = 'value') {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_request', `${name} is required`);
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!clean) fail('invalid_request', `${name} is required`);
  if (Buffer.byteLength(clean) > maximum) fail('invalid_request', `${name} is too long`);
  return clean;
}
function lightId(device) {
  return `govee-${crypto.createHash('sha256').update(`${device.sku}\0${device.device}`).digest('hex').slice(0, 16)}`;
}
function capabilityKey(capability) { return `${capability?.type || ''}:${capability?.instance || ''}`; }
function optionsOf(capability) {
  return Array.isArray(capability?.parameters?.options) ? capability.parameters.options : [];
}
function capabilitySummary(capability) {
  const range = capability?.parameters?.range;
  return {
    type: capability.type,
    instance: capability.instance,
    dataType: capability?.parameters?.dataType || null,
    range: range && Number.isFinite(range.min) && Number.isFinite(range.max)
      ? { min: range.min, max: range.max, precision: range.precision ?? 1 }
      : null,
  };
}
function isLight(device) {
  // Govee also returns virtual groups (for example SameModeGroup and
  // DreamViewScenic) with a power capability but no device type. Those
  // entries do not support the device state or scene endpoints and must not
  // be treated as independently controllable bulbs.
  return LIGHT_TYPES.has(device?.type);
}
function publicDevice(device) {
  return {
    id: lightId(device),
    name: String(device.deviceName || 'Govee light').slice(0, 120),
    model: String(device.sku || '').slice(0, 40),
    capabilities: (device.capabilities || []).filter((capability) => USEFUL.has(capabilityKey(capability))).map(capabilitySummary),
  };
}
function findCapability(device, type, instance) {
  return (device.capabilities || []).find((capability) => capability.type === type && capability.instance === instance);
}
function stateValue(states, type, instance) {
  return states.find((capability) => capability?.type === type && capability?.instance === instance)?.state?.value;
}
function normalizeRgb(value) {
  if (!isObject(value)) fail('invalid_request', 'rgb must contain red, green, and blue');
  const channels = ['red', 'green', 'blue'].map((key) => Number(value[key]));
  if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    fail('invalid_request', 'RGB channels must be integers from 0 to 255');
  }
  return (channels[0] << 16) | (channels[1] << 8) | channels[2];
}
function normalizeSettings(value) {
  if (!isObject(value)) fail('invalid_request', 'settings must be an object');
  for (const key of Object.keys(value)) {
    if (!['power', 'brightness', 'rgb', 'colorTemperatureK'].includes(key)) fail('invalid_request', 'unsupported light setting');
  }
  if (!Object.keys(value).length) fail('invalid_request', 'at least one light setting is required');
  const settings = {};
  if (Object.hasOwn(value, 'power')) {
    if (typeof value.power !== 'boolean') fail('invalid_request', 'power must be boolean');
    settings.power = value.power;
  }
  if (Object.hasOwn(value, 'brightness')) {
    if (!Number.isInteger(value.brightness)) fail('invalid_request', 'brightness must be an integer');
    settings.brightness = value.brightness;
  }
  if (Object.hasOwn(value, 'rgb')) settings.rgb = normalizeRgb(value.rgb);
  if (Object.hasOwn(value, 'colorTemperatureK')) {
    if (!Number.isInteger(value.colorTemperatureK)) fail('invalid_request', 'colorTemperatureK must be an integer');
    settings.colorTemperatureK = value.colorTemperatureK;
  }
  if (settings.rgb !== undefined && settings.colorTemperatureK !== undefined) {
    fail('invalid_request', 'choose RGB or color temperature, not both');
  }
  return settings;
}
function sceneKind(instance) {
  return instance === 'lightScene' ? 'dynamic' : instance === 'diyScene' ? 'diy' : 'snapshot';
}
function sceneId(device, capability, option) {
  const hash = crypto.createHash('sha256')
    .update(`${device.sku}\0${device.device}\0${capability.type}\0${capability.instance}\0${option.name}\0${JSON.stringify(option.value)}`)
    .digest('hex').slice(0, 20);
  return `scene-${hash}`;
}
function collectScenes(device, capabilities) {
  const output = [];
  const seen = new Set();
  for (const capability of capabilities) {
    if (!SCENE_INSTANCES.has(capability?.instance)) continue;
    for (const option of optionsOf(capability)) {
      const name = String(option?.name || '').trim();
      if (!name) continue;
      const key = `${sceneKind(capability.instance)}:${name.toLocaleLowerCase('en-US')}:${JSON.stringify(option.value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        id: sceneId(device, capability, option),
        name: name.slice(0, 160),
        kind: sceneKind(capability.instance),
        capability: { type: capability.type, instance: capability.instance, value: option.value },
      });
    }
  }
  return output;
}

function migrateHomeSchema(database) {
  if (!Array.isArray(database.sidebrainLightPresets)) database.sidebrainLightPresets = [];
  return database;
}

function createHomeService({
  getDatabase,
  replaceDatabase,
  persistDatabase,
  goveeClient,
  now = () => new Date(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  confirmationPollIntervalMs = 1_000,
  confirmationPollAttempts = 6,
} = {}) {
  if (typeof getDatabase !== 'function' || typeof replaceDatabase !== 'function' || typeof persistDatabase !== 'function') {
    throw new TypeError('database callbacks are required');
  }
  if (!goveeClient) throw new TypeError('goveeClient is required');
  if (typeof sleep !== 'function' || !Number.isInteger(confirmationPollIntervalMs) || confirmationPollIntervalMs < 0 ||
      !Number.isInteger(confirmationPollAttempts) || confirmationPollAttempts < 1 || confirmationPollAttempts > 20) {
    throw new TypeError('valid Govee confirmation polling options are required');
  }

  async function inventory() {
    const devices = (await goveeClient.listDevices()).filter(isLight);
    if (devices.length > 20) fail('govee_inventory_too_large', 'Govee returned too many lights');
    return devices;
  }
  function selectDevices(devices, target) {
    if (target === 'all') return devices;
    if (!Array.isArray(target) || target.length < 1 || target.length > 20) fail('invalid_request', 'target must be all or a list of light IDs');
    const requested = new Set(target.map((value) => safeText(value, 64, 'light ID')));
    const selected = devices.filter((device) => requested.has(lightId(device)));
    if (selected.length !== requested.size) fail('not_found', 'one or more lights were not found');
    return selected;
  }
  async function listLights(input = {}) {
    assertKeys(input, []);
    const devices = await inventory();
    return {
      configured: true,
      lights: await Promise.all(devices.map(async (device) => {
        const states = await goveeClient.getState(device);
        const online = stateValue(states, 'devices.capabilities.online', 'online');
        const power = stateValue(states, 'devices.capabilities.on_off', 'powerSwitch');
        return {
          ...publicDevice(device),
          online: online === undefined ? null : online === true,
          state: {
            power: power === undefined ? null : power === true || power === 1,
            brightness: stateValue(states, 'devices.capabilities.range', 'brightness') ?? null,
            rgb: stateValue(states, 'devices.capabilities.color_setting', 'colorRgb') ?? null,
            colorTemperatureK: stateValue(states, 'devices.capabilities.color_setting', 'colorTemperatureK') ?? null,
          },
        };
      })),
    };
  }
  async function scenesFor(device) {
    const dynamic = findCapability(device, 'devices.capabilities.dynamic_scene', 'lightScene')
      ? await goveeClient.listDynamicScenes(device) : [];
    const hasDiy = (device.capabilities || []).some((capability) => capability.instance === 'diyScene');
    const diy = hasDiy ? await goveeClient.listDiyScenes(device) : [];
    return collectScenes(device, [...(device.capabilities || []), ...dynamic, ...diy]);
  }
  async function listScenes(input = {}) {
    assertKeys(input, ['target']);
    const devices = await inventory();
    const selected = selectDevices(devices, input.target || 'all');
    return {
      lights: await Promise.all(selected.map(async (device) => ({
        light: publicDevice(device),
        scenes: (await scenesFor(device)).map(({ capability: _capability, ...scene }) => scene),
      }))),
    };
  }
  function validateForDevice(device, settings) {
    const commands = [];
    if (settings.power !== undefined) {
      const capability = findCapability(device, 'devices.capabilities.on_off', 'powerSwitch');
      if (!capability) fail('unsupported_capability', `${publicDevice(device).name} does not expose power control`);
      const option = optionsOf(capability).find((item) => String(item.name).toLowerCase() === (settings.power ? 'on' : 'off'));
      commands.push({ type: capability.type, instance: capability.instance, value: option?.value ?? (settings.power ? 1 : 0) });
    }
    if (settings.brightness !== undefined) {
      const capability = findCapability(device, 'devices.capabilities.range', 'brightness');
      const range = capability?.parameters?.range;
      if (!capability || !range || settings.brightness < range.min || settings.brightness > range.max) {
        fail('unsupported_capability', `${publicDevice(device).name} does not support that brightness`);
      }
      commands.push({ type: capability.type, instance: capability.instance, value: settings.brightness });
    }
    if (settings.rgb !== undefined) {
      const capability = findCapability(device, 'devices.capabilities.color_setting', 'colorRgb');
      if (!capability) fail('unsupported_capability', `${publicDevice(device).name} does not expose RGB control`);
      commands.push({ type: capability.type, instance: capability.instance, value: settings.rgb });
    }
    if (settings.colorTemperatureK !== undefined) {
      const capability = findCapability(device, 'devices.capabilities.color_setting', 'colorTemperatureK');
      const range = capability?.parameters?.range;
      if (!capability || !range || settings.colorTemperatureK < range.min || settings.colorTemperatureK > range.max) {
        fail('unsupported_capability', `${publicDevice(device).name} does not support that color temperature`);
      }
      commands.push({ type: capability.type, instance: capability.instance, value: settings.colorTemperatureK });
    }
    return commands;
  }
  function stateConfirmsSettings(states, settings) {
    if (settings.power !== undefined) {
      const power = stateValue(states, 'devices.capabilities.on_off', 'powerSwitch');
      if ((power === true || power === 1) !== settings.power) return false;
    }
    if (settings.brightness !== undefined &&
        stateValue(states, 'devices.capabilities.range', 'brightness') !== settings.brightness) return false;
    if (settings.rgb !== undefined &&
        stateValue(states, 'devices.capabilities.color_setting', 'colorRgb') !== settings.rgb) return false;
    if (settings.colorTemperatureK !== undefined &&
        stateValue(states, 'devices.capabilities.color_setting', 'colorTemperatureK') !== settings.colorTemperatureK) return false;
    return true;
  }
  async function confirmSettings(device, settings) {
    let confirmationError = null;
    for (let attempt = 1; attempt <= confirmationPollAttempts; attempt += 1) {
      if (attempt > 1) await sleep(confirmationPollIntervalMs);
      try {
        const states = await goveeClient.getState(device);
        confirmationError = null;
        if (stateConfirmsSettings(states, settings)) return { stateConfirmed: true, confirmationAttempts: attempt };
      } catch (error) {
        confirmationError = typeof error?.code === 'string' ? error.code : 'state_unavailable';
      }
    }
    return {
      stateConfirmed: false,
      confirmationAttempts: confirmationPollAttempts,
      ...(confirmationError ? { confirmationError } : {}),
    };
  }
  async function deviceIsOffline(device) {
    try {
      const states = await goveeClient.getState(device);
      return stateValue(states, 'devices.capabilities.online', 'online') === false;
    } catch {
      return false;
    }
  }
  async function controlLights(input) {
    assertKeys(input, ['target', 'settings']);
    const settings = normalizeSettings(input.settings);
    const devices = selectDevices(await inventory(), input.target);
    const plan = devices.map((device) => ({ device, commands: validateForDevice(device, settings) }));
    const results = [];
    for (const { device, commands } of plan) {
      if (await deviceIsOffline(device)) {
        results.push({ light: publicDevice(device), apiAccepted: false, stateConfirmed: false, skipped: 'offline' });
        continue;
      }
      for (const command of commands) await goveeClient.control(device, command);
      results.push({ light: publicDevice(device), apiAccepted: true, ...(await confirmSettings(device, settings)) });
    }
    return { changed: devices.map(publicDevice), settings: { ...settings, rgb: input.settings.rgb }, results };
  }
  async function activateScene(input) {
    assertKeys(input, ['target', 'kind', 'sceneId', 'sceneName', 'confirmed']);
    if (!!input.sceneId === !!input.sceneName) fail('invalid_request', 'provide exactly one scene selector');
    const kind = input.kind === undefined || input.kind === null ? null : safeText(input.kind, 20, 'scene kind');
    if (kind && !['dynamic', 'diy', 'snapshot'].includes(kind)) fail('invalid_request', 'invalid scene kind');
    const selector = input.sceneId ? { id: safeText(input.sceneId, 80, 'scene ID') } : { name: safeText(input.sceneName, 160, 'scene name') };
    if (selector.name && DISRUPTIVE_SCENE.test(selector.name) && input.confirmed !== true) {
      fail('confirmation_required', 'This scene name suggests flashing or alarm effects; explicit confirmation is required');
    }
    const devices = selectDevices(await inventory(), input.target);
    if (selector.id && devices.length > 1) fail('invalid_request', 'use a scene name when targeting multiple lights');
    const plan = [];
    for (const device of devices) {
      const matches = (await scenesFor(device)).filter((scene) => (!kind || scene.kind === kind) && (
        selector.id ? scene.id === selector.id : scene.name.toLocaleLowerCase('en-US') === selector.name.toLocaleLowerCase('en-US')
      ));
      if (matches.length !== 1) fail(matches.length ? 'ambiguous_scene' : 'not_found', `Scene was not uniquely found for ${publicDevice(device).name}`);
      plan.push({ device, scene: matches[0] });
    }
    const activated = [];
    for (const { device, scene } of plan) {
      if (await deviceIsOffline(device)) {
        activated.push({ light: publicDevice(device), scene: { id: scene.id, name: scene.name, kind: scene.kind }, apiAccepted: false, stateConfirmed: false, skipped: 'offline' });
        continue;
      }
      await goveeClient.control(device, scene.capability);
      activated.push({
        light: publicDevice(device),
        scene: { id: scene.id, name: scene.name, kind: scene.kind },
        apiAccepted: true,
        stateConfirmed: null,
        confirmationReason: 'Govee does not expose queryable active-scene state',
      });
    }
    return { activated };
  }
  async function savePreset(input) {
    assertKeys(input, ['name', 'assignments', 'replace']);
    const name = safeText(input.name, 80, 'preset name');
    if (!Array.isArray(input.assignments) || input.assignments.length < 1 || input.assignments.length > 20) {
      fail('invalid_request', 'preset assignments must contain 1-20 lights');
    }
    const devices = await inventory();
    const byId = new Map(devices.map((device) => [lightId(device), device]));
    const seen = new Set();
    const assignments = input.assignments.map((assignment) => {
      assertKeys(assignment, ['lightId', 'settings']);
      const id = safeText(assignment.lightId, 64, 'light ID');
      if (seen.has(id) || !byId.has(id)) fail('invalid_request', 'preset contains a duplicate or unknown light');
      seen.add(id);
      const settings = normalizeSettings(assignment.settings);
      validateForDevice(byId.get(id), settings);
      return { lightId: id, settings };
    });
    const next = migrateHomeSchema(structuredClone(getDatabase()));
    const existing = next.sidebrainLightPresets.find((preset) => preset.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'));
    if (existing && input.replace !== true) fail('confirmation_required', 'A preset with this name exists; confirm replacement');
    const timestamp = now().toISOString();
    const preset = existing || { id: `preset-${crypto.randomUUID()}`, createdAt: timestamp };
    Object.assign(preset, { name, assignments, updatedAt: timestamp });
    if (!existing) next.sidebrainLightPresets.push(preset);
    persistDatabase(next);
    replaceDatabase(next);
    return { id: preset.id, name: preset.name, lightCount: assignments.length, updatedAt: timestamp };
  }
  function listPresets(input = {}) {
    assertKeys(input, []);
    const database = migrateHomeSchema(structuredClone(getDatabase()));
    return { presets: database.sidebrainLightPresets.map((preset) => ({ id: preset.id, name: preset.name, lightCount: preset.assignments.length, updatedAt: preset.updatedAt })) };
  }
  async function activatePreset(input) {
    assertKeys(input, ['name']);
    const name = safeText(input?.name, 80, 'preset name');
    const database = migrateHomeSchema(structuredClone(getDatabase()));
    const matches = database.sidebrainLightPresets.filter((preset) => preset.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'));
    if (matches.length !== 1) fail(matches.length ? 'ambiguous_preset' : 'not_found', 'Preset was not uniquely found');
    const devices = await inventory();
    const byId = new Map(devices.map((device) => [lightId(device), device]));
    const plan = [];
    for (const assignment of matches[0].assignments) {
      const device = byId.get(assignment.lightId);
      if (!device) fail('not_found', 'A preset light is no longer available');
      plan.push({ device, commands: validateForDevice(device, assignment.settings) });
    }
    const changed = [];
    const results = [];
    for (const { device, commands } of plan) {
      if (await deviceIsOffline(device)) {
        results.push({ light: publicDevice(device), apiAccepted: false, stateConfirmed: false, skipped: 'offline' });
        continue;
      }
      for (const command of commands) await goveeClient.control(device, command);
      changed.push(publicDevice(device));
      const assignment = matches[0].assignments.find((item) => item.lightId === lightId(device));
      results.push({ light: publicDevice(device), apiAccepted: true, ...(await confirmSettings(device, assignment.settings)) });
    }
    return { preset: { id: matches[0].id, name: matches[0].name }, changed, results };
  }

  return { activatePreset, activateScene, controlLights, listLights, listPresets, listScenes, savePreset };
}

module.exports = { createHomeService, lightId, migrateHomeSchema, normalizeSettings };
