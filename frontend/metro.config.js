const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
const apiSourceRoot = `${path.resolve(__dirname, "..", "api", "src")}${path.sep}`;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isApiSourceImport =
    context.originModulePath.startsWith(apiSourceRoot) &&
    moduleName.startsWith(".") &&
    moduleName.endsWith(".js");

  if (isApiSourceImport) {
    return context.resolveRequest(
      context,
      `${moduleName.slice(0, -".js".length)}.ts`,
      platform,
    );
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
