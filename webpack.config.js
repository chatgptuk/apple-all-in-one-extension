const webpack = require('webpack'),
  path = require('path'),
  CopyWebpackPlugin = require('copy-webpack-plugin'),
  HtmlWebpackPlugin = require('html-webpack-plugin'),
  MiniCssExtractPlugin = require('mini-css-extract-plugin'),
  ASSET_PATH = process.env.ASSET_PATH || '/',
  FIREFOX = process.env.FIREFOX === 'true';

const isDev = process.env.NODE_ENV !== 'production';


const applyFirefoxManifestTransformations = (manifest) => {
  const {
    background: { service_worker },
  } = manifest;

  return {
    ...manifest,
    permissions: (manifest.permissions || []).filter((permission) => permission !== 'favicon'),
    background: { scripts: [service_worker] },
    browser_specific_settings: {
      gecko: {
        id: '{5f2806a5-f66d-40c6-8fb2-6018753b5626}',
        strict_min_version: '113.0',
      },
    },
  };
};

const options = {
  mode: isDev ? 'development' : 'production',
  entry: {
    popup: path.join(__dirname, 'src', 'pages', 'Popup', 'index.tsx'),
    background: path.join(__dirname, 'src', 'pages', 'Background', 'index.ts'),
    contentScript: path.join(__dirname, 'src', 'pages', 'Content', 'index.ts'),
    passwordsContent: path.join(__dirname, 'src', 'passwords', 'content.js'),
    passkeyBridge: path.join(__dirname, 'src', 'passwords', 'passkey-bridge.js'),
    passkeyGuard: path.join(__dirname, 'src', 'passwords', 'passkey-guard.js'),
    options: path.join(__dirname, 'src', 'pages', 'Options', 'index.tsx'),
    userguide: path.join(__dirname, 'src', 'pages', 'Userguide', 'index.tsx'),
  },
  chromeExtensionBoilerplate: {
    notHotReload: ['background', 'contentScript', 'passwordsContent', 'passkeyBridge', 'passkeyGuard'],
  },
  output: {
    filename: '[name].bundle.js',
    path: path.resolve(__dirname, 'build'),
    clean: true,
    publicPath: ASSET_PATH,
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
      { test: /\.(ts|tsx)$/, loader: 'ts-loader', exclude: /node_modules/ },
    ],
  },
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.css'],
  },
  plugins: [
    new MiniCssExtractPlugin(),
    new webpack.ProgressPlugin(),
    new webpack.EnvironmentPlugin(['NODE_ENV']),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'src/manifest.json',
          to: path.join(__dirname, 'build'),
          force: true,
          transform: function (content) {
            const manifest = JSON.parse(content.toString());
            return Buffer.from(
              JSON.stringify({
                ...(!FIREFOX
                  ? manifest
                  : applyFirefoxManifestTransformations(manifest)),
                version: process.env.npm_package_version || manifest.version,
              })
            );
          },
        },
        { from: 'src/background-bootstrap.js', to: path.join(__dirname, 'build'), force: true },
        { from: 'src/rules.json', to: path.join(__dirname, 'build'), force: true },
        { from: 'src/_locales', to: path.join(__dirname, 'build', '_locales'), force: true },
        { from: 'src/passwords/inline.html', to: path.join(__dirname, 'build', 'src', 'inline.html'), force: true },
        { from: 'src/passwords/password-generator.js', to: path.join(__dirname, 'build', 'src', 'password-generator.js'), force: true },
        { from: 'src/passwords/inline.css', to: path.join(__dirname, 'build', 'src', 'inline.css'), force: true },
        { from: 'src/passwords/inline.js', to: path.join(__dirname, 'build', 'src', 'inline.js'), force: true },
        { from: 'LICENSES', to: path.join(__dirname, 'build', 'licenses'), force: true },
        { from: 'THIRD_PARTY_NOTICES.md', to: path.join(__dirname, 'build'), force: true },
        { from: 'OPEN_PASSWORDS_NOTICE', to: path.join(__dirname, 'build'), force: true },

        { from: 'src/assets/img/icon-128.png', to: path.join(__dirname, 'build'), force: true },
        { from: 'src/assets/img/icon-48.png', to: path.join(__dirname, 'build'), force: true },
        { from: 'src/assets/img/icon-32.png', to: path.join(__dirname, 'build'), force: true },
        { from: 'src/assets/img/icon-16.png', to: path.join(__dirname, 'build'), force: true },
      ],
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'pages', 'Popup', 'index.html'),
      filename: 'popup.html',
      chunks: ['popup'],
      cache: false,
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'pages', 'Options', 'index.html'),
      filename: 'options.html',
      chunks: ['options'],
      cache: false,
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'pages', 'Userguide', 'index.html'),
      filename: 'userguide.html',
      chunks: ['userguide'],
      cache: false,
    }),
  ],
  infrastructureLogging: { level: 'info' },
};

if (isDev) {
  options.devtool = 'cheap-module-source-map';
}

module.exports = options;
