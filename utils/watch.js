process.env.NODE_ENV = 'development';
process.env.ASSET_PATH = '/';

const webpack = require('webpack');
const config = require('../webpack.config');

delete config.chromeExtensionBoilerplate;
config.mode = 'development';

const compiler = webpack(config);
compiler.watch({}, (err, stats) => {
  if (err) {
    console.error(err);
    return;
  }
  if (stats?.hasErrors()) {
    console.error(stats.toString({ colors: true, all: false, errors: true, warnings: true }));
    return;
  }
  console.log(stats?.toString({ colors: true, all: false, assets: true, timings: true }));
  console.log('Build updated. Reload the unpacked extension in your browser.');
});
