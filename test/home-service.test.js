'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHomeService, lightId } = require('../lib/home-service');

const cap = (type, instance, parameters) => ({ type, instance, parameters });
function fixtureDevices() {
  return ['Desk', 'Floor', 'Bed'].map((name, index) => ({
    sku: `H600${index + 1}`, device: `device-${index + 1}`, deviceName: name, type: 'devices.types.light',
    capabilities: [
      cap('devices.capabilities.on_off', 'powerSwitch', { dataType: 'ENUM', options: [{ name: 'on', value: 1 }, { name: 'off', value: 0 }] }),
      cap('devices.capabilities.range', 'brightness', { dataType: 'INTEGER', range: { min: 1, max: 100, precision: 1 } }),
      cap('devices.capabilities.color_setting', 'colorRgb', { dataType: 'INTEGER', range: { min: 0, max: 16777215, precision: 1 } }),
      cap('devices.capabilities.color_setting', 'colorTemperatureK', { dataType: 'INTEGER', range: { min: 2000, max: 6500, precision: 1 } }),
      cap('devices.capabilities.dynamic_scene', 'lightScene', { dataType: 'ENUM', options: [] }),
      cap('devices.capabilities.dynamic_scene', 'diyScene', { dataType: 'ENUM', options: [{ name: 'Custom glow', value: 77 }] }),
      cap('devices.capabilities.dynamic_scene', 'snapshot', { dataType: 'ENUM', options: [{ name: 'Saved calm', value: index }] }),
    ],
  }));
}

function harness() {
  let database = { sidebrainLightPresets: [] };
  const controls = [];
  const devices = fixtureDevices();
  const client = {
    listDevices: async () => structuredClone(devices),
    getState: async () => [
      { type: 'devices.capabilities.online', instance: 'online', state: { value: true } },
      { type: 'devices.capabilities.on_off', instance: 'powerSwitch', state: { value: 1 } },
      { type: 'devices.capabilities.range', instance: 'brightness', state: { value: 42 } },
    ],
    listDynamicScenes: async () => [cap('devices.capabilities.dynamic_scene', 'lightScene', { options: [{ name: 'Ocean', value: { id: 1, paramId: 2 } }, { name: 'Strobe alarm', value: { id: 3 } }] })],
    listDiyScenes: async () => [cap('devices.capabilities.diy_color_setting', 'diyScene', { options: [{ name: 'DIY sunset', value: 88 }] })],
    control: async (device, capability) => { controls.push({ device: device.deviceName, capability }); return true; },
  };
  const service = createHomeService({
    getDatabase: () => database,
    replaceDatabase: (next) => { database = next; },
    persistDatabase: () => {},
    goveeClient: client,
    now: () => new Date('2026-08-16T12:00:00Z'),
    sleep: async () => {},
    confirmationPollIntervalMs: 0,
    confirmationPollAttempts: 2,
  });
  return { service, client, controls, devices, getDatabase: () => database };
}

test('home service discovers all three bulbs, online state, useful capabilities, and every scene kind', async () => {
  const { service } = harness();
  const lights = await service.listLights();
  assert.equal(lights.lights.length, 3);
  assert.equal(lights.lights.every((light) => light.online), true);
  assert.equal(lights.lights[0].state.brightness, 42);
  assert.equal(lights.lights[0].capabilities.some((item) => item.instance === 'colorTemperatureK'), true);
  const scenes = await service.listScenes({ target: 'all' });
  assert.deepEqual(new Set(scenes.lights[0].scenes.map((scene) => scene.kind)), new Set(['dynamic', 'diy', 'snapshot']));
  assert.equal(JSON.stringify(scenes).includes('paramId'), false);
});

test('home service excludes Govee virtual groups that only mimic light power capability', async () => {
  const virtualGroup = {
    device: 'virtual-group-1',
    deviceName: 'Bedroom',
    sku: 'SameModeGroup',
    type: '',
    capabilities: [cap('devices.capabilities.on_off', 'powerSwitch', {
      dataType: 'ENUM',
      options: [{ name: 'on', value: 1 }, { name: 'off', value: 0 }],
    })],
  };
  const { service, client, devices } = harness();
  client.listDevices = async () => [...devices, virtualGroup];
  client.getState = async (device) => {
    assert.notEqual(device.sku, 'SameModeGroup');
    return [
      { type: 'devices.capabilities.online', instance: 'online', state: { value: true } },
      { type: 'devices.capabilities.on_off', instance: 'powerSwitch', state: { value: 1 } },
    ];
  };
  const result = await service.listLights({});

  assert.equal(result.lights.length, 3);
  assert.equal(result.lights.some((light) => light.model === 'SameModeGroup'), false);
});

test('home service validates discovered ranges and sends only discovered exact capability commands', async () => {
  const { service, controls } = harness();
  const lights = (await service.listLights()).lights;
  await service.controlLights({ target: [lights[0].id], settings: { power: true, brightness: 55, rgb: { red: 1, green: 2, blue: 3 } } });
  assert.deepEqual(controls.map((item) => item.capability), [
    { type: 'devices.capabilities.on_off', instance: 'powerSwitch', value: 1 },
    { type: 'devices.capabilities.range', instance: 'brightness', value: 55 },
    { type: 'devices.capabilities.color_setting', instance: 'colorRgb', value: 66051 },
  ]);
  await assert.rejects(service.controlLights({ target: [lights[0].id], settings: { colorTemperatureK: 9000 } }), /does not support/);
  await assert.rejects(service.controlLights({ target: [lights[0].id], settings: { power: true }, arbitrary: true }), (error) => error.code === 'invalid_request');
});

test('control verification polls through a stale first state without resending an accepted command', async () => {
  let database = { sidebrainLightPresets: [] };
  const device = fixtureDevices()[0];
  const controls = [];
  let stateReads = 0;
  let sleeps = 0;
  const service = createHomeService({
    getDatabase: () => database,
    replaceDatabase: (next) => { database = next; },
    persistDatabase: () => {},
    goveeClient: {
      listDevices: async () => [structuredClone(device)],
      control: async (_device, capability) => { controls.push(capability); return true; },
      getState: async () => {
        stateReads += 1;
        return [
          { type: 'devices.capabilities.online', instance: 'online', state: { value: true } },
          { type: 'devices.capabilities.range', instance: 'brightness', state: { value: stateReads < 3 ? 42 : 55 } },
        ];
      },
    },
    sleep: async () => { sleeps += 1; },
    confirmationPollIntervalMs: 1_000,
    confirmationPollAttempts: 6,
  });

  const result = await service.controlLights({ target: [lightId(device)], settings: { brightness: 55 } });

  assert.equal(controls.length, 1);
  assert.equal(stateReads, 3);
  assert.equal(sleeps, 1);
  assert.deepEqual(result.results.map(({ apiAccepted, stateConfirmed, confirmationAttempts }) => ({ apiAccepted, stateConfirmed, confirmationAttempts })), [
    { apiAccepted: true, stateConfirmed: true, confirmationAttempts: 2 },
  ]);
});

test('batch controls skip an offline bulb and continue reachable bulbs without sending to the offline device', async () => {
  const { service, client, controls, devices } = harness();
  client.getState = async (device) => [
    { type: 'devices.capabilities.online', instance: 'online', state: { value: device.deviceName !== 'Desk' } },
    { type: 'devices.capabilities.on_off', instance: 'powerSwitch', state: { value: 0 } },
  ];
  const result = await service.controlLights({ target: 'all', settings: { power: false } });
  assert.equal(controls.some((entry) => entry.device === 'Desk'), false);
  assert.deepEqual(new Set(controls.map((entry) => entry.device)), new Set(devices.slice(1).map((item) => item.deviceName)));
  assert.equal(result.results.find((entry) => entry.light.name === 'Desk').skipped, 'offline');
});

test('dynamic scene safeguards require confirmation only for disruptive names', async () => {
  const { service, controls } = harness();
  const light = (await service.listLights()).lights[0];
  await service.activateScene({ target: [light.id], kind: 'dynamic', sceneName: 'Ocean' });
  assert.equal(controls.at(-1).capability.instance, 'lightScene');
  await assert.rejects(service.activateScene({ target: [light.id], kind: 'dynamic', sceneName: 'Strobe alarm' }), (error) => error.code === 'confirmation_required');
  await service.activateScene({ target: [light.id], kind: 'dynamic', sceneName: 'Strobe alarm', confirmed: true });
});

test('named presets persist different settings for all bulbs and replay them', async () => {
  const { service, controls, getDatabase } = harness();
  const lights = (await service.listLights()).lights;
  await service.savePreset({
    name: 'Movie', assignments: [
      { lightId: lights[0].id, settings: { power: true, brightness: 15, rgb: { red: 20, green: 5, blue: 40 } } },
      { lightId: lights[1].id, settings: { power: true, brightness: 5, colorTemperatureK: 2200 } },
      { lightId: lights[2].id, settings: { power: false } },
    ],
  });
  assert.equal(getDatabase().sidebrainLightPresets[0].assignments.length, 3);
  assert.deepEqual((await service.listPresets()).presets.map((preset) => preset.name), ['Movie']);
  controls.length = 0;
  await service.activatePreset({ name: 'movie' });
  assert.equal(controls.length, 7);
  await assert.rejects(service.savePreset({ name: 'Movie', assignments: [{ lightId: lights[0].id, settings: { power: false } }] }), (error) => error.code === 'confirmation_required');
});
