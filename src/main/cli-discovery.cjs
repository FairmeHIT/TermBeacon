// Development tools share Settings' catalog, source selection, and probes.
const path = require("node:path");
const { createCliManager } = require("./cli-manager.cjs");
const { resolveAssets } = require("./integration-config.cjs");
const manager = createCliManager({ assets: resolveAssets({ appPath: path.resolve(__dirname, "../..") }) });

async function discoverAll(instance = manager) {
  return Object.fromEntries((await instance.scan()).agents.map((agent) => [agent.id, agent]));
}
const getLaunchSpec = (request) => manager.launch(request);

module.exports = { discoverAll, getLaunchSpec };
