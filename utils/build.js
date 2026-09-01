process.env.NODE_ENV = 'production';
process.env.ASSET_PATH = '/';
process.env.MANIFEST_VERSION = process.env.MANIFEST_VERSION || '3';

var webpack = require('webpack'),
  config = require('../webpack.config');

delete config.chromeExtensionBoilerplate;
config.mode = 'production';

webpack(config, function (err, stats) {
  if (err) throw err;
  if (stats?.hasErrors()) {
    console.error(stats.toString({ colors: true, all: false, errors: true, warnings: true }));
    process.exitCode = 1;
  }
});
